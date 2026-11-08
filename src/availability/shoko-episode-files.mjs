import path from 'node:path';
import { readBoundedJson } from '../http/bounded-response.mjs';
import { evaluatePreview } from '../identity/evaluate-preview.mjs';
import { exactShokoOfflineLink } from './shoko-offline-link.mjs';

const unavailable = () => ({ state: 'unavailable' });
const validId = (value) => Number.isSafeInteger(value) && value > 0;
const validPath = (value) => typeof value === 'string' &&
  value.length <= 4096 &&
  path.posix.isAbsolute(value) && path.posix.normalize(value) === value &&
  !value.includes('\0') && !value.includes('\r') && !value.includes('\n') &&
  !value.includes('\\');
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
      !['registered', 'availability', 'first_time'].includes(purpose) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 ||
      typeof fetchImpl !== 'function') throw new TypeError('Invalid Shoko episode observation');
  const url = new URL(`/api/v3/Episode/AniDB/${episodeId}/Episode`, base);
  url.searchParams.set('includeFiles', 'true');
  url.searchParams.set('includeReleaseInfo', 'true');
  url.searchParams.set('includeXRefs', 'true');
  url.searchParams.set('includeAbsolutePaths', 'true');
  const exactMetadataExists = async () => {
    try {
      const metadataUrl = new URL(`/api/v3/Episode/AniDB/${episodeId}`, base);
      const response = await fetchImpl(metadataUrl, { method: 'GET',
        redirect: 'manual', headers: { Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
      if (response.status !== 200) return false;
      const metadata = await readBoundedJson(response, 100_000);
      return metadata?.ID === episodeId && metadata.AnimeID === anidbId;
    } catch { return false; }
  };
  let episode;
  try {
    const response = await fetchImpl(url, { method: 'GET', redirect: 'manual',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs) });
    if (response.status === 404) {
      // Shoko uses this 404 both for absent AniDB metadata and for an AniDB
      // episode with no local Shoko episode. Confirm which case occurred.
      return await exactMetadataExists()
        ? { state: 'not_imported', anidbId, episodeId } : unavailable();
    }
    if (response.status !== 200) return unavailable();
    episode = await readBoundedJson(response, 2_000_000);
  } catch { return unavailable(); }
  if (episode?.IDs?.AniDB !== episodeId || !Array.isArray(episode.Files) ||
      episode.Files.length > 50) return unavailable();
  // Shoko can create an episode row before importing any file. For a first
  // acquisition, confirm its AniDB anime identity before treating it as empty.
  if (purpose === 'first_time' && episode.Files.length === 0) {
    return await exactMetadataExists()
      ? { state: 'empty_episode', anidbId, episodeId } : unavailable();
  }
  const files = [];
  let incomplete = false;
  let unscopedUserEpisodeVerified;
  for (const file of episode.Files) {
    if (!validId(file?.ID) || !Number.isSafeInteger(file.Size) || file.Size <= 0 ||
        file.IsIgnored !== false || !Array.isArray(file.Hashes) ||
        !Array.isArray(file.Locations) || file.Locations.length === 0 ||
        file.Locations.length > 20 || !Array.isArray(file.Release?.CrossReferences)) {
      incomplete = true; continue;
    }
    // A public playback-status observation may use an existing flagged file.
    // Registered acquisition still rejects it before import.
    if (file.Release.IsCorrupted !== false &&
        !(purpose === 'availability' &&
          file.Release.ProviderName === 'AniDB' &&
          file.Release.IsCorrupted === true)) {
      incomplete = true; continue;
    }
    const ed2k = file.Hashes.find((hash) => hash?.Type === 'ED2K')?.Value;
    const refs = file.Release.CrossReferences;
    const unscopedUserRef = purpose === 'availability' &&
      file.Release.ProviderName === 'User' && file.Release.ID == null &&
      refs.length === 1 && refs[0]?.AnidbAnimeID === null &&
      refs[0].AnidbEpisodeID === episodeId;
    if (!/^[0-9A-F]{32}$/.test(ed2k) || refs.length === 0 ||
        refs.some((ref) => (ref?.AnidbAnimeID !== anidbId &&
          !(unscopedUserRef && ref.AnidbAnimeID === null)) ||
          !validId(ref.AnidbEpisodeID)) ||
        !refs.some((ref) => ref.AnidbEpisodeID === episodeId)) {
      incomplete = true; continue;
    }
    if (unscopedUserRef) {
      if (unscopedUserEpisodeVerified === undefined) {
        try {
          const metadataUrl = new URL(`/api/v3/Episode/AniDB/${episodeId}`, base);
          const response = await fetchImpl(metadataUrl, { method: 'GET',
            redirect: 'manual', headers: { Authorization: `Bearer ${apiKey}`,
              Accept: 'application/json' },
            signal: AbortSignal.timeout(timeoutMs) });
          const metadata = response.status === 200
            ? await readBoundedJson(response, 100_000) : null;
          unscopedUserEpisodeVerified = metadata?.ID === episodeId &&
            metadata.AnimeID === anidbId;
        } catch { unscopedUserEpisodeVerified = false; }
      }
      if (!unscopedUserEpisodeVerified) { incomplete = true; continue; }
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
    if (identity.state !== 'accepted' && purpose === 'availability' &&
        exactShokoOfflineLink(file.Release, anidbId, episodeId)) {
      identity = { state: 'accepted', fileId: null,
        coverage: [{ episodeId, start: 0, end: 100 }],
        releaseEvidence: 'shoko_offline_link' };
    }
    if (identity.state !== 'accepted') { incomplete = true; continue; }
    if (purpose === 'availability' && identity.isCorrupted === true) {
      identity = { ...identity, releaseEvidence: 'anidb_flagged' };
    }
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
