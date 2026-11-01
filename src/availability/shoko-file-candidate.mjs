import path from 'node:path';
import { readBoundedJson } from '../http/bounded-response.mjs';
import { evaluatePreview } from '../identity/evaluate-preview.mjs';
import { normalizeShokoFile } from './shoko-file-page.mjs';

const unavailable = () => ({ state: 'unavailable' });
const validId = (value) => Number.isSafeInteger(value) && value > 0;
const validPath = (value) => typeof value === 'string' &&
  value.length <= 4096 && path.posix.isAbsolute(value) &&
  path.posix.normalize(value) === value && !/[\0\r\n\\]/.test(value);
const pairKey = (pair) => `${pair.anidbId}:${pair.episodeId}`;

// Positive candidate discovery for a file already named by Shoko. Its
// episode links and source paths still need exact public Plex card and
// same-file proof before any Available status can be published.
export async function readShokoFileCandidate({ baseUrl, apiKey, fileId,
  fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  let base;
  try { base = new URL(baseUrl); } catch { throw new TypeError('Invalid Shoko URL'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
      base.search || base.hash || base.pathname !== '/' ||
      typeof apiKey !== 'string' || !apiKey || !validId(fileId) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 ||
      typeof fetchImpl !== 'function') {
    throw new TypeError('Invalid Shoko file candidate configuration');
  }
  const url = new URL(`/api/v3/File/${fileId}`, base);
  url.searchParams.append('include', 'XRefs');
  url.searchParams.append('include', 'ReleaseInfo');
  url.searchParams.set('includeAbsolutePaths', 'true');
  let file;
  try {
    const response = await fetchImpl(url, { method: 'GET', redirect: 'manual',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs) });
    if (response.status !== 200) return unavailable();
    file = await readBoundedJson(response, 200_000);
  } catch { return unavailable(); }
  const item = normalizeShokoFile(file);
  if (item?.fileId !== fileId || item.state !== 'linked' ||
      file.IsIgnored !== false || !validId(file.Size) ||
      !Array.isArray(file.Locations) || file.Locations.length < 1 ||
      file.Locations.length > 20 ||
      file.Release?.IsCorrupted !== false ||
      !Array.isArray(file.Release.CrossReferences) ||
      file.Release.CrossReferences.length !== item.pairs.length) return unavailable();
  const identities = [];
  for (const series of file.SeriesIDs) {
    const shokoSeriesId = series?.SeriesID?.ID;
    if (!validId(shokoSeriesId)) return unavailable();
    for (const episode of series.EpisodeIDs) {
      const shokoEpisodeId = episode?.ID;
      const tmdbMovieIds = episode?.TMDB?.Movie ?? [];
      if (!validId(shokoEpisodeId) || !Array.isArray(tmdbMovieIds) ||
          tmdbMovieIds.length > 20 || tmdbMovieIds.some((id) => !validId(id)) ||
          new Set(tmdbMovieIds).size !== tmdbMovieIds.length) return unavailable();
      identities.push({ anidbId: series.SeriesID.AniDB,
        episodeId: episode.AniDB, shokoSeriesId, shokoEpisodeId,
        tmdbMovieIds });
    }
  }
  const refs = file.Release.CrossReferences;
  const linked = new Set(item.pairs.map(pairKey));
  if (refs.some((ref) => !ref ||
      !linked.has(`${ref.AnidbAnimeID}:${ref.AnidbEpisodeID}`) ||
      !Object.hasOwn(ref, 'PercentageStart') ||
      !Object.hasOwn(ref, 'PercentageEnd') ||
      (ref.PercentageStart !== null && ref.PercentageStart !== 0) ||
      (ref.PercentageEnd !== null && ref.PercentageEnd !== 100) ||
      ((ref.PercentageStart === null) !== (ref.PercentageEnd === null))) ||
      new Set(refs.map((ref) =>
        `${ref.AnidbAnimeID}:${ref.AnidbEpisodeID}`)).size !== refs.length) {
    return unavailable();
  }
  let anidbFileId = null;
  let releaseEvidence;
  if (file.Release.ProviderName === 'AniDB') {
    const animeIds = new Set(item.pairs.map((pair) => pair.anidbId));
    const digest = Array.isArray(file.Hashes)
      ? file.Hashes.find((hash) => hash?.Type === 'ED2K')?.Value : null;
    if (animeIds.size !== 1 || !/^[0-9A-F]{32}$/.test(digest)) {
      return unavailable();
    }
    const decision = evaluatePreview({ status: 200, release: file.Release },
      { ed2k: digest, size: file.Size, animeId: [...animeIds][0],
        episodeIds: item.pairs.map((pair) => pair.episodeId) });
    if (decision.state !== 'accepted') return unavailable();
    anidbFileId = decision.fileId;
    releaseEvidence = 'registered';
  } else if (file.Release.ProviderName === 'User' && file.Release.ID == null) {
    releaseEvidence = 'shoko_user_link';
  } else return unavailable();
  const sourcePaths = [];
  for (const location of file.Locations) {
    if (location?.FileID !== fileId ||
        typeof location.IsAccessible !== 'boolean') return unavailable();
    if (!location.IsAccessible) continue;
    if (!validPath(location.AbsolutePath)) return unavailable();
    sourcePaths.push(location.AbsolutePath);
  }
  if (sourcePaths.length === 0 || new Set(sourcePaths).size !== sourcePaths.length) {
    return unavailable();
  }
  return { state: 'candidate', fileId, size: file.Size,
    anidbFileId, releaseEvidence, pairs: item.pairs,
    identities, sourcePaths };
}
