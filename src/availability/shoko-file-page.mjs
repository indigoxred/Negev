import { readBoundedJson } from '../http/bounded-response.mjs';

const unavailable = () => ({ state: 'unavailable' });
const validId = (id) => Number.isSafeInteger(id) && id > 0;

export function normalizeShokoFile(file) {
  if (!validId(file?.ID) || typeof file.Updated !== 'string' ||
      !Number.isFinite(Date.parse(file.Updated))) return null;
  const pairs = [];
  const seenPairs = new Set();
  let invalid = file.SeriesIDs != null &&
    (!Array.isArray(file.SeriesIDs) || file.SeriesIDs.length > 100);
  for (const series of invalid ? [] : file.SeriesIDs ?? []) {
    if (!validId(series?.SeriesID?.AniDB) || !Array.isArray(series.EpisodeIDs) ||
        series.EpisodeIDs.length < 1 || series.EpisodeIDs.length > 100) {
      invalid = true; break;
    }
    for (const episode of series.EpisodeIDs) {
      if (!validId(episode?.AniDB)) { invalid = true; break; }
      const key = `${series.SeriesID.AniDB}:${episode.AniDB}`;
      if (seenPairs.has(key)) { invalid = true; break; }
      seenPairs.add(key);
      pairs.push({ anidbId: series.SeriesID.AniDB, episodeId: episode.AniDB });
    }
    if (invalid) break;
  }
  return { fileId: file.ID, updated: file.Updated,
    state: invalid ? 'unverified' : pairs.length ? 'linked' : 'provisional',
    pairs: invalid ? [] : pairs };
}

// One read-only inventory page, including Shoko's import-limbo files that its
// default list hides. An empty page never proves an older file was deleted.
export async function readShokoFilePage({ baseUrl, apiKey, page = 1,
  pageSize = 100, fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  let base;
  try { base = new URL(baseUrl); } catch { throw new TypeError('Invalid Shoko URL'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
      base.search || base.hash || base.pathname !== '/' ||
      typeof apiKey !== 'string' || !apiKey ||
      !Number.isSafeInteger(page) || page < 1 || page > 10_000 ||
      !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 ||
      typeof fetchImpl !== 'function') throw new TypeError('Invalid Shoko file page');

  const url = new URL('/api/v3/File', base);
  url.searchParams.set('page', String(page));
  url.searchParams.set('pageSize', String(pageSize));
  url.searchParams.append('include', 'XRefs,ImportLimbo');
  url.searchParams.set('sortOrder', 'FileID');
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
    const item = normalizeShokoFile(file);
    if (!item || seenFiles.has(item.fileId)) return unavailable();
    seenFiles.add(item.fileId);
    items.push(item);
  }
  if (items.length > data.Total) return unavailable();
  return { state: 'page', page, total: data.Total, items };
}
