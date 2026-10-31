import path from 'node:path';
import { evaluateExactAvailability } from './exact-availability.mjs';
import { provePhysicalPlexPart } from './physical-plex-part.mjs';

const unknown = (reason) => ({ state: 'unknown', reason });
const inside = (root, candidate) => {
  const relative = path.posix.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith('../') &&
    !path.posix.isAbsolute(relative));
};
const validRemote = (value) => typeof value === 'string' &&
  path.posix.isAbsolute(value) && path.posix.normalize(value) === value &&
  !/[\0\r\n\\]/.test(value);
const validMount = (mapping) => validRemote(mapping?.appRoot) && mapping.appRoot !== '/' &&
  typeof mapping.localRoot === 'string' && path.isAbsolute(mapping.localRoot) &&
  path.normalize(mapping.localRoot) === mapping.localRoot &&
  !/[\0\r\n]/.test(mapping.localRoot);
const localPath = (remote, mapping) => {
  if (!validRemote(remote) || !inside(mapping.appRoot, remote)) return null;
  const relative = path.posix.relative(mapping.appRoot, remote);
  return path.join(mapping.localRoot, ...relative.split('/'));
};

// This joins one known Plex card to one exact Shoko AniDB episode. It is
// positive evidence only: missing cards, Shoko 404s and incomplete key
// discovery cannot prove absence or authorize acquisition.
export async function observeKnownCardAvailability({ target, shoko, plex,
  publicLibraryIds, shokoMount, plexMount, plexMounts, maxChecks = 64,
  proveImpl = provePhysicalPlexPart } = {}) {
  const mounts = plexMounts ?? (plexMount ? [plexMount] : []);
  if (!Number.isSafeInteger(target?.anidbId) || target.anidbId <= 0 ||
      !Number.isSafeInteger(target.episodeId) || target.episodeId <= 0 ||
      !Array.isArray(publicLibraryIds) || publicLibraryIds.length === 0 ||
      publicLibraryIds.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
      !validMount(shokoMount) || !Array.isArray(mounts) ||
      mounts.length < 1 || mounts.length > 8 ||
      mounts.some((mapping) => !validMount(mapping)) ||
      mounts.some((mapping, index) => mounts.some((other, otherIndex) =>
        index !== otherIndex && inside(mapping.appRoot, other.appRoot))) ||
      !Number.isSafeInteger(maxChecks) || maxChecks < 0 || maxChecks > 256 ||
      typeof proveImpl !== 'function') throw new TypeError('Invalid availability mounts or budget');
  if (shoko?.state !== 'ok' || typeof shoko.complete !== 'boolean' ||
      !Array.isArray(shoko.files) ||
      plex?.state !== 'ok' || plex.complete !== true || !Array.isArray(plex.parts) ||
      shoko.files.length > 50 || plex.parts.length > 400 ||
      shoko.files.length === 0 || plex.parts.some((part) =>
        !Number.isSafeInteger(part?.libraryId) || part.libraryId <= 0 ||
        !Number.isSafeInteger(part.size) || part.size <= 0 ||
        typeof part.plexPath !== 'string')) return unknown('observer_incomplete');
  // A readable Part under a different Plex episode or show is not available
  // to the requested installment. An AniDB movie can be a native Anime
  // episode card or a true Plex Movie card with one exact Shoko-linked TMDB ID.
  if (!['series', 'movie'].includes(target.kind) ||
      !Number.isSafeInteger(shoko.shokoEpisodeId) || shoko.shokoEpisodeId < 1 ||
      !Number.isSafeInteger(shoko.shokoSeriesId) || shoko.shokoSeriesId < 1) {
    return unknown('card_identity_unverified');
  }
  const episodeGuid = `tv.plex.agents.custom.shoko://episode/e${shoko.shokoEpisodeId}`;
  const showGuid = `tv.plex.agents.custom.shoko://show/${shoko.shokoSeriesId}`;
  const movieGuid = Array.isArray(shoko.tmdbMovieIds) &&
    shoko.tmdbMovieIds.length === 1 &&
    Number.isSafeInteger(shoko.tmdbMovieIds[0]) && shoko.tmdbMovieIds[0] > 0
    ? `tmdb://${shoko.tmdbMovieIds[0]}` : null;
  const identityParts = plex.parts.filter((part) =>
    (part.cardType === 'episode' && part.itemGuid === episodeGuid &&
      part.showGuid === showGuid) ||
    (target.kind === 'movie' && part.cardType === 'movie' && movieGuid &&
      (part.itemGuid === movieGuid || part.externalGuids?.includes(movieGuid))));
  if (identityParts.length === 0) return unknown('card_identity_unverified');
  if (maxChecks === 0) return unknown('comparison_budget_exceeded');
  const publicIds = new Set(publicLibraryIds);
  const files = [];
  const parts = [];
  let checks = 0;
  let incompletePhysical = false;
  for (const file of shoko.files) {
    if (file?.anidbId !== target?.anidbId || !file.episodeIds?.includes(target.episodeId) ||
        !Array.isArray(file.sourcePaths) || file.sourcePaths.length === 0 ||
        file.sourcePaths.length > 20 || !Number.isSafeInteger(file.size) || file.size <= 0) {
      return unknown('observer_incomplete');
    }
    let matched = false;
    for (const remoteSource of file.sourcePaths) {
      const shokoPath = localPath(remoteSource, shokoMount);
      if (!shokoPath) return unknown('path_mapping_failed');
      for (const part of identityParts) {
        if (!publicIds.has(part.libraryId) || part.size !== file.size) continue;
        const mapping = mounts.find((entry) => localPath(part.plexPath, entry));
        const plexPath = mapping && localPath(part.plexPath, mapping);
        if (!plexPath) return unknown('path_mapping_failed');
        if (++checks > maxChecks) return unknown('comparison_budget_exceeded');
        let witness;
        try {
          witness = await proveImpl({ shokoPath, plexPath,
            shokoRoot: shokoMount.localRoot, plexRoot: mapping.localRoot,
            expectedSize: file.size });
        } catch { return unknown('physical_evidence_incomplete'); }
        if (witness?.state === 'same_file' && typeof witness.storageKey === 'string' &&
            witness.storageKey.length > 0) {
          matched = true;
          files.push({ fileId: file.fileId, anidbId: file.anidbId,
            episodeIds: file.episodeIds, coverage: file.coverage,
            storageKey: witness.storageKey });
          parts.push({ storageKey: witness.storageKey, libraryId: part.libraryId, readable: true });
        } else if (['file_unavailable', 'file_changed'].includes(witness?.reason)) {
          incompletePhysical = true;
        } else if (witness?.reason !== 'different_file' && witness?.reason !== 'size_mismatch') {
          return unknown('physical_evidence_incomplete');
        }
      }
    }
    if (!matched) files.push({ fileId: file.fileId, anidbId: file.anidbId,
      episodeIds: file.episodeIds, coverage: file.coverage,
      storageKey: `unmatched:${file.fileId}` });
  }
  const result = evaluateExactAvailability({ target,
    shoko: { state: 'ok', complete: true, files },
    plex: { state: 'ok', complete: true, parts }, publicLibraryIds });
  // A registered playable file is positive proof even if a sibling could
  // not be parsed. A partial Shoko response cannot support a negative claim.
  if (shoko.complete === false && result.state !== 'available') {
    return unknown('observer_incomplete');
  }
  // One known card cannot establish a complete negative observation.
  if (result.state === 'absent') return unknown('observer_incomplete');
  if (result.state === 'available' || result.state === 'held') return result;
  return incompletePhysical ? unknown('physical_evidence_incomplete') : result;
}
