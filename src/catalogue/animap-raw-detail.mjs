import { readBoundedJson } from '../http/bounded-response.mjs';

const kindFor = (value) => value === 'Movie' ? 'movie' :
  ['TV Series', 'TV Special', 'TV Short', 'OVA', 'Web', 'Other'].includes(value)
    ? 'series' : null;
const episodeType = new Map([['1', 'Episode'], ['2', 'Special'],
  ['3', 'Credit'], ['4', 'Trailer'], ['5', 'Parody'], ['6', 'Other']]);
const validDate = (value) => value == null || typeof value === 'string' &&
  /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(value);
const numberFrom = (value) => typeof value === 'string' &&
  /^(?:[STCOP])?([1-9]\d*)$/.test(value)
  ? Number(value.match(/\d+$/)[0]) : null;
const intFrom = (value) => typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value)
  ? Number(value) : null;
const asArray = (value) => value == null ? [] : Array.isArray(value) ? value : [value];
const unavailable = () => ({ state: 'unavailable' });

function textFor(value) {
  const choices = asArray(value).filter((item) => typeof item?.['#text'] === 'string');
  const picked = choices.find((item) => item['@lang'] === 'en') ??
    choices.find((item) => item['@type'] === 'main') ?? choices[0];
  return picked?.['#text']?.trim() ?? '';
}

function parseRecord(data, anidbId) {
  const anime = data?.anime;
  const kind = kindFor(anime?.type);
  const title = textFor(anime?.titles?.title);
  const restricted = anime?.['@restricted'] === 'true' ? true :
    anime?.['@restricted'] === 'false' ? false : null;
  const episodeCount = anime?.episodecount == null ? null : intFrom(anime.episodecount);
  const raw = asArray(anime?.episodes?.episode);
  if (intFrom(anime?.['@id']) !== anidbId || !kind || restricted === null ||
      !title || title.length > 300 || /[\x00-\x1f\x7f]/.test(title) ||
      !validDate(anime.startdate) || !validDate(anime.enddate) ||
      (anime.episodecount != null && (episodeCount === null || episodeCount > 10_000)) ||
      raw.length > 2_000) return null;
  const ids = new Set();
  const episodes = [];
  for (const item of raw) {
    const id = intFrom(item?.['@id']);
    const type = episodeType.get(item?.epno?.['@type']);
    const number = numberFrom(item?.epno?.['#text']);
    const episodeTitle = textFor(item?.title);
    if (!Number.isSafeInteger(id) || id < 1 || ids.has(id) || !type ||
        !Number.isSafeInteger(number) || number < 1 ||
        episodeTitle.length > 500 || !validDate(item?.airdate)) return null;
    ids.add(id);
    episodes.push({ id, number, type, title: episodeTitle,
      airDate: item.airdate ?? null });
  }
  return { title, kind, restricted, airDate: anime.startdate ?? null,
    endDate: anime.enddate ?? null, episodeCount, episodes };
}

// A public AniDB snapshot supplies exact episode IDs while Shoko is still
// hydrating an unowned title. It never proves a file or Plex availability.
export function createAniMapRawDetailReader({ fetchImpl = fetch,
  now = Date.now, timeoutMs = 4_500, pageSize = 100 } = {}) {
  if (typeof fetchImpl !== 'function' || typeof now !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000 ||
      !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new TypeError('Invalid AniDB archive reader');
  }
  const cache = new Map();
  const pending = new Map();
  const queue = [];
  let active = 0;
  const fetchRecord = async (anidbId) => {
    try {
      const response = await fetchImpl(`https://animap.id/api/anidb/${anidbId}/raw`, {
        method: 'GET', redirect: 'manual', headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status !== 200) return null;
      return parseRecord(await readBoundedJson(response, 2_000_000), anidbId);
    } catch { return null; }
  };
  const pump = () => {
    while (active < 2 && queue.length) {
      const job = queue.shift();
      active++;
      void fetchRecord(job.anidbId).then((value) => {
        cache.set(job.anidbId, { value, expiresMs: now() +
          (value ? 600_000 : 30_000) });
        while (cache.size > 100) cache.delete(cache.keys().next().value);
        pending.delete(job.anidbId);
        job.resolve(value);
      }).finally(() => { active--; pump(); });
    }
  };
  return { async read({ anidbId, page = 1 }) {
    if (!Number.isSafeInteger(anidbId) || anidbId < 1 || anidbId > 2_147_483_647 ||
        !Number.isSafeInteger(page) || page < 1 || page > 1_000) {
      throw new TypeError('Invalid AniDB archive page');
    }
    let hit = cache.get(anidbId);
    if (!hit || hit.expiresMs <= now()) {
      let read = pending.get(anidbId);
      if (!read) {
        if (queue.length >= 20) return unavailable();
        read = new Promise((resolve) => {
          queue.push({ anidbId, resolve });
          pump();
        });
        pending.set(anidbId, read);
      }
      hit = { value: await read };
    }
    if (!hit.value) return unavailable();
    const { episodes, ...metadata } = hit.value;
    const start = (page - 1) * pageSize;
    if (start > episodes.length || page > 1 && start === episodes.length) return unavailable();
    const selected = episodes.slice(start, start + pageSize);
    return { state: 'details', anidbId, ...metadata, total: episodes.length,
      page, complete: page === 1 && episodes.length <= pageSize,
      nextPage: start + selected.length < episodes.length ? page + 1 : null,
      episodes: selected, requestable: false };
  } };
}
