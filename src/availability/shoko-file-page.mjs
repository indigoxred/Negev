import { readBoundedJson } from '../http/bounded-response.mjs';

const unavailable = () => ({ state: 'unavailable' });
const validId = (id) => Number.isSafeInteger(id) && id > 0;

// One read-only inventory page. It reports positive file IDs only; a page,
// including an empty one, never proves that an older file was deleted.
export async function readShokoFilePage({ baseUrl, apiKey, page = 1,
  pageSize = 25, fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  let base;
  try { base = new URL(baseUrl); } catch { throw new TypeError('Invalid Shoko URL'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
      base.search || base.hash || base.pathname !== '/' ||
      typeof apiKey !== 'string' || !apiKey ||
      !Number.isSafeInteger(page) || page < 1 || page > 10_000 ||
      !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 ||
      typeof fetchImpl !== 'function') throw new TypeError('Invalid Shoko file page');

  const url = new URL('/api/v3/File', base);
  url.searchParams.set('page', String(page));
  url.searchParams.set('pageSize', String(pageSize));
  url.searchParams.append('include', 'XRefs');
  let data;
  try {
    const response = await fetchImpl(url, { method: 'GET', redirect: 'manual',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs) });
    if (response.status !== 200) return unavailable();
    data = await readBoundedJson(response, 1_000_000);
  } catch { return unavailable(); }
  if (!Number.isSafeInteger(data?.Total) || data.Total < 0 ||
      !Array.isArray(data.List) || data.List.length > pageSize) return unavailable();
  const seenFiles = new Set();
  const items = [];
  for (const file of data.List) {
    if (!validId(file?.ID) || seenFiles.has(file.ID) ||
        typeof file.Updated !== 'string' || !Number.isFinite(Date.parse(file.Updated)) ||
        (file.SeriesIDs != null && !Array.isArray(file.SeriesIDs))) return unavailable();
    seenFiles.add(file.ID);
    const pairs = [];
    const seenPairs = new Set();
    for (const series of file.SeriesIDs ?? []) {
      if (!validId(series?.SeriesID?.AniDB) || !Array.isArray(series.EpisodeIDs) ||
          series.EpisodeIDs.length < 1 || series.EpisodeIDs.length > 100) return unavailable();
      for (const episode of series.EpisodeIDs) {
        if (!validId(episode?.AniDB)) return unavailable();
        const key = `${series.SeriesID.AniDB}:${episode.AniDB}`;
        if (seenPairs.has(key)) return unavailable();
        seenPairs.add(key);
        pairs.push({ anidbId: series.SeriesID.AniDB, episodeId: episode.AniDB });
      }
    }
    items.push({ fileId: file.ID, updated: file.Updated,
      state: pairs.length ? 'linked' : 'provisional', pairs });
  }
  if (items.length > data.Total) return unavailable();
  return { state: 'page', page, total: data.Total, items };
}
