import { observeIndexedTarget } from './observe-indexed-target.mjs';
import { probePhysicalCandidate } from './physical-plex-part.mjs';

const unknown = () => ({ state: 'unknown', reason: 'file_identity_unverified' });
const validId = (value) => Number.isSafeInteger(value) && value > 0;
const key = (value) => `${value.anidbId}:${value.episodeId}`;

// Reuse one fresh Shoko file candidate for its linked episodes. The public
// observer still reads the selected Plex card and proves the same readable
// file; this function neither persists a badge nor authorizes acquisition.
export async function observeFileCandidateTarget({ candidate, target,
  publicLibraryIds, cardIndex, readPlex, shokoMount, plexMount, plexMounts,
  proveImpl, probeImpl = probePhysicalCandidate, now = Date.now } = {}) {
  if (!validId(target?.anidbId) || !validId(target.episodeId) ||
      !['series', 'movie'].includes(target.kind) ||
      candidate?.state !== 'candidate' || !validId(candidate.fileId) ||
      !validId(candidate.size) ||
      !['registered', 'anidb_flagged', 'shoko_user_link']
        .includes(candidate.releaseEvidence) ||
      (['registered', 'anidb_flagged'].includes(candidate.releaseEvidence) &&
        !validId(candidate.anidbFileId)) ||
      !Array.isArray(candidate.pairs) || candidate.pairs.length < 1 ||
      candidate.pairs.length > 100 ||
      candidate.pairs.some((pair) =>
        !validId(pair?.anidbId) || !validId(pair.episodeId)) ||
      !Array.isArray(candidate.identities) ||
      candidate.identities.length !== candidate.pairs.length ||
      !Array.isArray(candidate.sourcePaths) ||
      candidate.sourcePaths.length < 1 || candidate.sourcePaths.length > 20) {
    return unknown();
  }
  if (candidate.identities.some((item) =>
    !validId(item?.anidbId) || !validId(item.episodeId) ||
    !validId(item.shokoSeriesId) || !validId(item.shokoEpisodeId) ||
    !Array.isArray(item.tmdbMovieIds) || item.tmdbMovieIds.length > 20 ||
    item.tmdbMovieIds.some((id) => !validId(id)))) return unknown();
  const pairKeys = new Set(candidate.pairs.map(key));
  const identityKeys = new Set(candidate.identities.map(key));
  if (pairKeys.size !== candidate.pairs.length ||
      identityKeys.size !== candidate.identities.length ||
      [...identityKeys].some((value) => !pairKeys.has(value))) return unknown();
  const identity = candidate.identities.find((item) =>
    item.anidbId === target.anidbId && item.episodeId === target.episodeId);
  if (!identity) return unknown();
  const episodeIds = candidate.identities.filter((item) =>
    item.anidbId === target.anidbId).map((item) => item.episodeId);
  const linkedShokoEpisodeIds = target.kind === 'series'
    ? candidate.identities.filter((item) =>
      item.anidbId === target.anidbId &&
      item.shokoSeriesId === identity.shokoSeriesId)
      .map((item) => item.shokoEpisodeId)
    : [];
  if (new Set(linkedShokoEpisodeIds).size !== linkedShokoEpisodeIds.length) {
    return unknown();
  }
  const shoko = { state: 'ok', complete: true,
    shokoEpisodeId: identity.shokoEpisodeId,
    shokoSeriesId: identity.shokoSeriesId,
    linkedShokoEpisodeIds,
    tmdbMovieIds: identity.tmdbMovieIds,
    files: [{ fileId: candidate.fileId, anidbId: target.anidbId,
      episodeIds, coverage: episodeIds.map((episodeId) => ({
        episodeId, start: 0, end: 100 })), size: candidate.size,
      sourcePaths: candidate.sourcePaths }] };
  return observeIndexedTarget({ target, publicLibraryIds, cardIndex,
    readShoko: async () => shoko, readPlex, shokoMount, plexMount,
    plexMounts, proveImpl, probeImpl, now, includeProof: true });
}
