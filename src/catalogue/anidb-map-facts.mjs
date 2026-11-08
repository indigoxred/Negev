import { readBoundedJson } from '../http/bounded-response.mjs';

const seasons = new Map([['WINTER', 'Winter'], ['SPRING', 'Spring'],
  ['SUMMER', 'Summer'], ['FALL', 'Fall']]);
const statuses = new Map([['ONGOING', 'Airing'], ['FINISHED', 'Finished'],
  ['UPCOMING', 'Upcoming']]);

// Optional presentation facts from the public map. They never determine
// request targets, imported-file identity or Plex availability.
export function createAniDbMapFactsReader({ fetchImpl = fetch, now = Date.now,
  timeoutMs = 2_000 } = {}) {
  if (typeof fetchImpl !== 'function' || typeof now !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5_000) {
    throw new TypeError('Invalid map facts reader');
  }
  const cache = new Map();
  const pending = new Map();
  const read = async (anidbId) => {
    try {
      const response = await fetchImpl(`https://animap.id/api/v1/map/anidb/${anidbId}`, {
        method: 'GET', redirect: 'manual', headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status !== 200) return { state: 'unavailable' };
      const data = await readBoundedJson(response, 128_000);
      if (!Array.isArray(data?.sources) || data.sources.length > 100 ||
          !data.sources.includes(`https://anidb.net/anime/${anidbId}`)) {
        return { state: 'unavailable' };
      }
      const period = data.animeSeason;
      const season = seasons.get(period?.season) &&
        Number.isSafeInteger(period?.year) && period.year >= 1900 &&
        period.year <= 2100 ? `${seasons.get(period.season)} ${period.year}` : null;
      const studio = Array.isArray(data.studios) && data.studios.length <= 50
        ? data.studios.find((name) => typeof name === 'string' &&
          name.trim() && name.trim().length <= 100)?.trim() ?? null : null;
      const duration = data.duration;
      const durationMinutes = duration?.unit === 'SECONDS' &&
        Number.isSafeInteger(duration.value) && duration.value > 0 &&
        duration.value <= 86_400 ? Math.round(duration.value / 60) : null;
      return { state: 'facts', anidbId, season,
        status: statuses.get(data.status) ?? null, studio, durationMinutes };
    } catch { return { state: 'unavailable' }; }
  };
  return { read({ anidbId }) {
    if (!Number.isSafeInteger(anidbId) || anidbId < 1 || anidbId > 2_147_483_647) {
      throw new TypeError('Invalid AniDB ID');
    }
    const hit = cache.get(anidbId);
    if (hit && hit.expiresMs > now()) return Promise.resolve(hit.value);
    if (pending.has(anidbId)) return pending.get(anidbId);
    const result = read(anidbId).then((value) => {
      cache.set(anidbId, { value, expiresMs: now() +
        (value.state === 'facts' ? 6 * 60 * 60_000 : 60_000) });
      while (cache.size > 200) cache.delete(cache.keys().next().value);
      return value;
    }).finally(() => pending.delete(anidbId));
    pending.set(anidbId, result);
    return result;
  } };
}
