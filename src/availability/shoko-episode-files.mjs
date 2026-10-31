import path from 'node:path';
import { readBoundedJson } from '../http/bounded-response.mjs';
import { evaluatePreview } from '../identity/evaluate-preview.mjs';

const unavailable = () => ({ state: 'unavailable' });
const validId = (value) => Number.isSafeInteger(value) && value > 0;
const validPath = (value) => typeof value === 'string' &&
  path.posix.isAbsolute(value) && path.posix.normalize(value) === value &&
  !value.includes('\0') && !value.includes('\r') && !value.includes('\n');

// A single-episode, read-only Shoko observation. It never treats a missing
// local episode as proven absence; the caller must verify catalogue identity
// and import activity before making that decision.
export async function readShokoEpisodeFiles({ baseUrl, apiKey, anidbId, episodeId,
  fetchImpl = fetch, timeoutMs = 10_000 }) {
  let base;
  try { base = new URL(baseUrl); } catch { throw new TypeError('Invalid Shoko URL'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
      base.search || base.hash || base.pathname !== '/' ||
      typeof apiKey !== 'string' || !apiKey ||
      !validId(anidbId) || !validId(episodeId) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 ||
      typeof fetchImpl !== 'function') throw new TypeError('Invalid Shoko episode observation');
  const url = new URL(`/api/v3/Episode/AniDB/${episodeId}/Episode`, base);
  url.searchParams.set('includeFiles', 'true');
  url.searchParams.set('includeReleaseInfo', 'true');
  url.searchParams.set('includeXRefs', 'true');
  url.searchParams.set('includeAbsolutePaths', 'true');
  let episode;
  try {
    const response = await fetchImpl(url, { method: 'GET', redirect: 'manual',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs) });
    if (response.status === 404) return { state: 'not_imported' };
    if (response.status !== 200) return unavailable();
    episode = await readBoundedJson(response, 2_000_000);
  } catch { return unavailable(); }
  if (episode?.IDs?.AniDB !== episodeId || !Array.isArray(episode.Files) ||
      episode.Files.length > 50) return unavailable();
  const files = [];
  for (const file of episode.Files) {
    if (!validId(file?.ID) || !Number.isSafeInteger(file.Size) || file.Size <= 0 ||
        file.IsIgnored !== false || !Array.isArray(file.Hashes) ||
        !Array.isArray(file.Locations) || file.Locations.length === 0 ||
        file.Locations.length > 20 || !Array.isArray(file.Release?.CrossReferences)) {
      return unavailable();
    }
    if (file.Release.IsCorrupted !== false) return unavailable();
    const ed2k = file.Hashes.find((hash) => hash?.Type === 'ED2K')?.Value;
    const refs = file.Release.CrossReferences;
    if (!/^[0-9A-F]{32}$/.test(ed2k) || refs.length === 0 ||
        refs.some((ref) => ref?.AnidbAnimeID !== anidbId || !validId(ref.AnidbEpisodeID)) ||
        !refs.some((ref) => ref.AnidbEpisodeID === episodeId)) return unavailable();
    const episodeIds = refs.map((ref) => ref.AnidbEpisodeID);
    const identity = evaluatePreview({ status: 200, release: file.Release },
      { ed2k, size: file.Size, animeId: anidbId, episodeIds });
    if (identity.state !== 'accepted') return unavailable();
    const sourcePaths = [];
    for (const location of file.Locations) {
      if (location?.FileID !== file.ID || typeof location.IsAccessible !== 'boolean') {
        return unavailable();
      }
      if (!location.IsAccessible) continue;
      if (!validPath(location.AbsolutePath)) return unavailable();
      sourcePaths.push(location.AbsolutePath);
    }
    if (sourcePaths.length === 0) return unavailable();
    files.push({ fileId: file.ID, anidbFileId: identity.fileId, ed2k,
      anidbId, episodeIds, coverage: identity.coverage,
      size: file.Size, sourcePaths });
  }
  return { state: 'ok', complete: true, files };
}
