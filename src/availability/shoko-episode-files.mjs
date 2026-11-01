import path from 'node:path';
import { readBoundedJson } from '../http/bounded-response.mjs';
import { evaluatePreview } from '../identity/evaluate-preview.mjs';

const unavailable = () => ({ state: 'unavailable' });
const validId = (value) => Number.isSafeInteger(value) && value > 0;
const validPath = (value) => typeof value === 'string' &&
  path.posix.isAbsolute(value) && path.posix.normalize(value) === value &&
  !value.includes('\0') && !value.includes('\r') && !value.includes('\n');
const userCoverage = (refs) => {
  const seen = new Set();
  const coverage = [];
  for (const ref of refs) {
    const id = ref?.AnidbEpisodeID;
    const start = ref?.PercentageStart;
    const end = ref?.PercentageEnd;
    if (!validId(id) || seen.has(id) ||
        !Object.hasOwn(ref, 'PercentageStart') ||
        !Object.hasOwn(ref, 'PercentageEnd') ||
        ((start === null) !== (end === null)) ||
        (start !== null && (!Number.isFinite(start) ||
          !Number.isFinite(end) || start < 0 || end > 100 ||
          start >= end))) return null;
    seen.add(id);
    coverage.push({ episodeId: id, start: start ?? 0, end: end ?? 100 });
  }
  return coverage;
};

// A single-episode, read-only Shoko observation. The availability-only mode
// accepts a Shoko User link as local episode evidence so the separate Plex
// card/physical-file check can prove playback. New acquisition and handoff
// identity checks retain the registered AniDB-file default. A missing local
// episode never proves absence without catalogue and Import checks.
export async function readShokoEpisodeFiles({ baseUrl, apiKey, anidbId, episodeId,
  purpose = 'registered', fetchImpl = fetch, timeoutMs = 10_000 }) {
  let base;
  try { base = new URL(baseUrl); } catch { throw new TypeError('Invalid Shoko URL'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
      base.search || base.hash || base.pathname !== '/' ||
      typeof apiKey !== 'string' || !apiKey ||
      !validId(anidbId) || !validId(episodeId) ||
      !['registered', 'availability'].includes(purpose) ||
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
    if (response.status === 404) {
      // Shoko uses this 404 both for absent AniDB metadata and for an AniDB
      // episode with no local Shoko episode. Confirm which case occurred.
      const metadataUrl = new URL(`/api/v3/Episode/AniDB/${episodeId}`, base);
      const metadataResponse = await fetchImpl(metadataUrl, {
        method: 'GET', redirect: 'manual',
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (metadataResponse.status !== 200) return unavailable();
      const metadata = await readBoundedJson(metadataResponse, 100_000);
      return metadata?.ID === episodeId && metadata.AnimeID === anidbId
        ? { state: 'not_imported', anidbId, episodeId } : unavailable();
    }
    if (response.status !== 200) return unavailable();
    episode = await readBoundedJson(response, 2_000_000);
  } catch { return unavailable(); }
  if (episode?.IDs?.AniDB !== episodeId || !Array.isArray(episode.Files) ||
      episode.Files.length > 50) return unavailable();
  const files = [];
  let incomplete = false;
  for (const file of episode.Files) {
    if (!validId(file?.ID) || !Number.isSafeInteger(file.Size) || file.Size <= 0 ||
        file.IsIgnored !== false || !Array.isArray(file.Hashes) ||
        !Array.isArray(file.Locations) || file.Locations.length === 0 ||
        file.Locations.length > 20 || !Array.isArray(file.Release?.CrossReferences)) {
      incomplete = true; continue;
    }
    if (file.Release.IsCorrupted !== false) { incomplete = true; continue; }
    const ed2k = file.Hashes.find((hash) => hash?.Type === 'ED2K')?.Value;
    const refs = file.Release.CrossReferences;
    if (!/^[0-9A-F]{32}$/.test(ed2k) || refs.length === 0 ||
        refs.some((ref) => ref?.AnidbAnimeID !== anidbId || !validId(ref.AnidbEpisodeID)) ||
        !refs.some((ref) => ref.AnidbEpisodeID === episodeId)) {
      incomplete = true; continue;
    }
    const episodeIds = refs.map((ref) => ref.AnidbEpisodeID);
    let identity = evaluatePreview({ status: 200, release: file.Release },
      { ed2k, size: file.Size, animeId: anidbId, episodeIds });
    if (identity.state !== 'accepted' && purpose === 'availability' &&
        file.Release.ProviderName === 'User' && file.Release.ID == null) {
      const coverage = userCoverage(refs);
      if (coverage) identity = { state: 'accepted', fileId: null,
        coverage, releaseEvidence: 'shoko_user_link' };
    }
    if (identity.state !== 'accepted') { incomplete = true; continue; }
    const sourcePaths = [];
    let invalidLocation = false;
    for (const location of file.Locations) {
      if (location?.FileID !== file.ID || typeof location.IsAccessible !== 'boolean') {
        invalidLocation = true; break;
      }
      if (!location.IsAccessible) continue;
      if (!validPath(location.AbsolutePath)) { invalidLocation = true; break; }
      sourcePaths.push(location.AbsolutePath);
    }
    if (invalidLocation || sourcePaths.length === 0) {
      incomplete = true; continue;
    }
    files.push({ fileId: file.ID, anidbFileId: identity.fileId,
      ...(identity.releaseEvidence ? { releaseEvidence: identity.releaseEvidence } : {}),
      ed2k,
      anidbId, episodeIds, coverage: identity.coverage,
      size: file.Size, sourcePaths });
  }
  if (incomplete && files.length === 0) return unavailable();
  const movieIds = episode.IDs.TMDB?.Movie;
  return { state: 'ok', complete: !incomplete,
    shokoEpisodeId: validId(episode.IDs.ID) ? episode.IDs.ID : null,
    shokoSeriesId: validId(episode.IDs.ParentSeries) ?
      episode.IDs.ParentSeries : null,
    tmdbMovieIds: Array.isArray(movieIds) && movieIds.length <= 20 &&
      movieIds.every(validId) && new Set(movieIds).size === movieIds.length
      ? movieIds : [], files };
}
