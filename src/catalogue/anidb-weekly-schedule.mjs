import { readBoundedJson } from '../http/bounded-response.mjs';

const SOURCE = 'https://animap.id/api/anidb/schedule';
const validId = (value) => Number.isSafeInteger(value) && value > 0;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (value) => typeof value === 'string' &&
  datePattern.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

// AniMap's weekly AniDB schedule is display-only. It carries exact AniDB
// IDs, but it is not a complete seasonal catalogue or an acquisition gate.
export function createAniDbWeeklySchedule({ fetchImpl = fetch,
  now = Date.now, cacheMs = 2 * 60 * 60_000,
  staleMs = 24 * 60 * 60_000, timeoutMs = 8_000 } = {}) {
  if (typeof fetchImpl !== 'function' || typeof now !== 'function' ||
      ![cacheMs, staleMs, timeoutMs].every((value) =>
        Number.isSafeInteger(value) && value > 0) || staleMs <= cacheMs ||
      staleMs > 7 * 24 * 60 * 60_000 || timeoutMs > 60_000) {
    throw new TypeError('Invalid weekly schedule configuration');
  }
  let cached = null;
  let checkedMs = null;
  let lastAttemptMs = null;
  let pending = null;
  const result = (state) => cached && state !== 'unavailable'
    ? { state, week: cached.week, checkedMs, items: cached.items }
    : { state: 'unavailable' };
  const parse = (data) => {
    if (!/^\d{4}-W\d{2}$/.test(data?.period?.week ?? '') ||
        !validDate(data.period.start_date) ||
        !validDate(data.period.end_date) ||
        !Array.isArray(data.days) || data.days.length !== 7) {
      throw new TypeError('Invalid weekly schedule');
    }
    const byTitle = new Map();
    const seenDays = new Set();
    let entries = 0;
    for (const day of data.days) {
      if (!validDate(day?.date) || day.date < data.period.start_date ||
          day.date > data.period.end_date || seenDays.has(day.date) ||
          !Array.isArray(day.episodes) ||
          day.episodes.length > 200) throw new TypeError('Invalid schedule day');
      seenDays.add(day.date);
      entries += day.episodes.length;
      if (entries > 1_000) throw new TypeError('Schedule too large');
      for (const episode of day.episodes) {
        if (!validId(episode?.anidb_id) ||
            !validId(episode.anidb_episode_id) ||
            typeof episode.anime_title !== 'string' ||
            !episode.anime_title.trim() || episode.anime_title.length > 250 ||
            typeof episode.episode_number !== 'string' ||
            episode.episode_number.length > 24 ||
            typeof episode.episode_type !== 'string' ||
            typeof episode.adult_only !== 'boolean') {
          throw new TypeError('Invalid schedule episode');
        }
        if (episode.adult_only || episode.episode_type !== 'regular') continue;
        const existing = byTitle.get(episode.anidb_id);
        if (!existing || day.date < existing.scheduledDate) {
          byTitle.set(episode.anidb_id, {
            anidbId: episode.anidb_id, title: episode.anime_title,
            scheduledDate: day.date, episodeNumber: episode.episode_number,
          });
        }
      }
    }
    return { week: data.period.week, endDate: data.period.end_date,
      items: [...byTitle.values()].sort((a, b) =>
        a.scheduledDate.localeCompare(b.scheduledDate) ||
        a.title.localeCompare(b.title) || a.anidbId - b.anidbId) };
  };
  const read = async () => {
    const time = now();
    if (!Number.isSafeInteger(time) || time < 0) return { state: 'unavailable' };
    if (cached && checkedMs + cacheMs > time &&
        time <= Date.parse(`${cached.endDate}T23:59:59Z`)) return result('ready');
    if (lastAttemptMs === null || lastAttemptMs + 60_000 <= time) {
      lastAttemptMs = time;
      try {
        const response = await fetchImpl(SOURCE, { method: 'GET',
          redirect: 'manual', headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(timeoutMs) });
        if (response.status !== 200) throw new TypeError('Schedule unavailable');
        cached = parse(await readBoundedJson(response, 512_000));
        checkedMs = time;
        return result('ready');
      } catch { /* Preserve only a visibly stale, bounded observation. */ }
    }
    return cached && checkedMs + staleMs > time
      ? result('stale') : { state: 'unavailable' };
  };
  return { read() {
    if (!pending) pending = read().finally(() => { pending = null; });
    return pending;
  } };
}
