import { evaluateHandoffEvidence } from './handoff-evidence.mjs';
import path from 'node:path';

const held = (reason) => ({ state: 'held', reason });

// Observe a published provisional handoff by its exact hash and size. This
// makes no release link and makes no public Plex availability claim.
export async function observeProvisionalImport({ handoff, readImportedFile } = {}) {
  if (handoff?.status !== 'published_observed') return held('publish_not_observed');
  if (typeof readImportedFile !== 'function') throw new TypeError('Shoko file reader required');
  const manifest = handoff.manifest;
  const evidence = evaluateHandoffEvidence({ identity: manifest?.identity,
    version: manifest?.version, anidbId: manifest?.anidbId,
    torrentHash: manifest?.torrentHash, files: manifest?.videos,
    subtitles: manifest?.subtitles });
  if (evidence.state !== 'valid' || evidence.digest !== handoff.evidenceDigest ||
      JSON.stringify(evidence.manifest) !== JSON.stringify(manifest) ||
      manifest.identity !== 'provisional') {
    return held('handoff_evidence_mismatch');
  }
  const fileIds = [];
  let awaitingFile = null;
  let missing = false;
  for (const file of manifest.videos) {
    let observed;
    try { observed = await readImportedFile({ ed2k: file.ed2k, size: file.size }); }
    catch { return held('shoko_unavailable'); }
    if (observed?.state === 'not_imported') { missing = true; continue; }
    if (!['imported_unrecognized', 'imported_recognized'].includes(observed?.state)) {
      return held('shoko_unavailable');
    }
    if (observed.ed2k !== file.ed2k || observed.size !== file.size ||
        !Number.isSafeInteger(observed.fileId) || observed.fileId < 1 ||
        fileIds.includes(observed.fileId)) {
      return held('shoko_file_changed');
    }
    fileIds.push(observed.fileId);
    if (observed.state === 'imported_unrecognized') {
      awaitingFile ??= observed.fileId;
      continue;
    }
    const refs = observed.release?.crossReferences;
    if (observed.release?.isCorrupted !== false || !Array.isArray(refs) ||
        refs.length !== file.episodeIds.length ||
        !file.episodeIds.every((episodeId) => refs.some((ref) =>
          ref?.animeId === manifest.anidbId &&
          ref.episodeId === episodeId && ref.start === 0 && ref.end === 100))) {
      return held('shoko_identity_conflict');
    }
  }
  if (missing) return { state: 'awaiting_shoko' };
  if (awaitingFile !== null) return { state: 'awaiting_shoko_link', fileId: awaitingFile };
  return { state: 'shoko_files_identified', fileIds };
}

// Shoko recognition and final-library placement are separate observations.
// This uses the same hash lookup and requires an accessible location below
// the configured final library, without treating the Import path as success.
export async function observeProvisionalPlacement({ handoff, readImportedFile,
  libraryRoot } = {}) {
  if (typeof readImportedFile !== 'function' ||
      typeof libraryRoot !== 'string' || !path.posix.isAbsolute(libraryRoot) ||
      libraryRoot === '/' || path.posix.normalize(libraryRoot) !== libraryRoot ||
      /[\0\r\n\\]/.test(libraryRoot)) {
    throw new TypeError('Invalid provisional Shoko placement');
  }
  const observations = [];
  const identity = await observeProvisionalImport({ handoff,
    readImportedFile: async (query) => {
      const observed = await readImportedFile({ ...query, includeAbsolutePaths: true });
      observations.push(observed);
      return observed;
    } });
  if (identity.state !== 'shoko_files_identified') return identity;
  for (const [index, observed] of observations.entries()) {
    if (!Array.isArray(observed.locations) || observed.locations.length > 100 ||
        observed.locations.some((location) =>
        (location?.path !== null && typeof location?.path !== 'string') ||
        (location?.accessible === true && !location.path) ||
        typeof location.accessible !== 'boolean' ||
        !Number.isSafeInteger(location.managedFolderId) ||
        location.managedFolderId < 1)) return held('shoko_location_unavailable');
    const placed = observed.locations.some((location) => {
      if (!location.accessible || !path.posix.isAbsolute(location.path) ||
          path.posix.normalize(location.path) !== location.path) return false;
      const relative = path.posix.relative(libraryRoot, location.path);
      return relative !== '' && relative !== '..' &&
        !relative.startsWith('../') && !path.posix.isAbsolute(relative);
    });
    if (!placed) return { state: 'awaiting_shoko_placement',
      fileId: identity.fileIds[index] };
  }
  return { state: 'shoko_library_location_reported', fileIds: identity.fileIds };
}
