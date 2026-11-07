import { evaluateHandoffEvidence } from './handoff-evidence.mjs';
import { observeProvisionalImport } from './observe-provisional-import.mjs';
import path from 'node:path';

const held = (reason) => ({ state: 'held', reason });
const validId = (value) => Number.isSafeInteger(value) && value > 0;
const sameIds = (left, right) => Array.isArray(left) &&
  left.length === right.length && left.every((id) => right.includes(id));

// Read-only, bounded check of a previously published handoff. A positive
// result proves Shoko has identified each exact registered video and has an
// accessible location. The file may still be in Import; this does not prove
// Shoko moved it, Plex playback, or subtitle import.
const withinLibrary = (root, candidate) => {
  if (typeof candidate !== 'string' || !path.posix.isAbsolute(candidate) ||
      path.posix.normalize(candidate) !== candidate) return false;
  const relative = path.posix.relative(root, candidate);
  return relative !== '' && relative !== '..' &&
    !relative.startsWith('../') && !path.posix.isAbsolute(relative);
};

async function inspectExactShokoFiles({ handoff, readEpisode, libraryRoot }) {
  if (typeof readEpisode !== 'function') throw new TypeError('Episode reader required');
  const manifest = handoff.manifest;
  const evidence = evaluateHandoffEvidence({ anidbId: manifest?.anidbId,
    torrentHash: manifest?.torrentHash, files: manifest?.videos,
    subtitles: manifest?.subtitles });
  if (evidence.state !== 'valid' || evidence.digest !== handoff.evidenceDigest) {
    return held('handoff_evidence_mismatch');
  }
  const episodeIds = [...new Set(manifest.videos.flatMap((file) => file.episodeIds))]
    .sort((a, b) => a - b);
  if (episodeIds.length > 100) return held('episode_budget_exceeded');
  const observed = new Map();
  for (const episodeId of episodeIds) {
    let result;
    try { result = await readEpisode({ anidbId: manifest.anidbId, episodeId }); }
    catch { return held('shoko_unavailable'); }
    if (result?.state === 'not_imported' ||
        result?.state === 'ok' && result.complete === true &&
          Array.isArray(result.files) && result.files.length === 0) {
      return { state: 'awaiting_shoko', episodeId };
    }
    if (result?.state !== 'ok' || result.complete !== true ||
        !Array.isArray(result.files) || result.files.length > 50) {
      return held('shoko_unavailable');
    }
    for (const expected of manifest.videos.filter((file) => file.episodeIds.includes(episodeId))) {
      const matching = result.files.filter((file) =>
        file?.anidbId === manifest.anidbId &&
        file.anidbFileId === expected.anidbFileId &&
        file.ed2k === expected.ed2k && file.size === expected.size &&
        validId(file.fileId) && sameIds(file.episodeIds, expected.episodeIds) &&
        Array.isArray(file.sourcePaths) && file.sourcePaths.length > 0 &&
        expected.episodeIds.every((id) => file.coverage?.some((range) =>
          range.episodeId === id && range.start === 0 && range.end === 100)));
      if (matching.length === 0) return { state: 'awaiting_shoko', episodeId };
      if (matching.length !== 1) return held('ambiguous_shoko_file');
      const file = matching[0];
      if (libraryRoot && !file.sourcePaths.some((candidate) =>
        withinLibrary(libraryRoot, candidate))) {
        return { state: 'awaiting_shoko_placement', episodeId };
      }
      const prior = observed.get(expected.anidbFileId);
      if (prior !== undefined && prior !== file.fileId) {
        return held('inconsistent_shoko_file');
      }
      observed.set(expected.anidbFileId, file.fileId);
    }
  }
  return { state: 'shoko_files_identified',
    fileIds: manifest.videos.map((file) => observed.get(file.anidbFileId)) };
}

export async function observeHandoffImport({ handoff, readEpisode,
  readImportedFile } = {}) {
  if (handoff?.status !== 'published_observed') return held('publish_not_observed');
  if (handoff.manifest?.identity === 'provisional') {
    return observeProvisionalImport({ handoff, readImportedFile });
  }
  return inspectExactShokoFiles({ handoff, readEpisode });
}

// Shoko's accessible final-library location is distinct from identifying a
// file while it is still in Import. Plex card and playback proof remain later
// observations; this result does not claim either one.
export async function observeHandoffPlacement({ handoff, readEpisode,
  libraryRoot } = {}) {
  if (typeof libraryRoot !== 'string' || !path.posix.isAbsolute(libraryRoot) ||
      libraryRoot === '/' || path.posix.normalize(libraryRoot) !== libraryRoot ||
      /[\0\r\n\\]/.test(libraryRoot)) {
    throw new TypeError('Invalid Shoko library root');
  }
  if (handoff?.status !== 'published_observed') return held('publish_not_observed');
  const observed = await inspectExactShokoFiles({ handoff, readEpisode, libraryRoot });
  return observed.state === 'shoko_files_identified'
    ? { state: 'shoko_library_location_reported', fileIds: observed.fileIds }
    : observed;
}

// A saved publish intent can outlive Shoko's rapid move out of Import. This
// observes content only; it does not claim that this operation supplied it.
export async function reconcileHandoffContent({ attemptId, ledger, readEpisode, nowMs } = {}) {
  if (!validId(attemptId) || typeof ledger?.getHandoff !== 'function' ||
      typeof ledger?.recordContentPresent !== 'function' ||
      typeof readEpisode !== 'function' ||
      !Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new TypeError('Invalid handoff reconciliation');
  }
  const handoff = ledger.getHandoff(attemptId);
  if (handoff?.status !== 'publish_unknown') return held('publish_intent_missing');
  if (handoff.publishName !== `negev-${attemptId}-${handoff.evidenceDigest?.slice(0, 16)}`) {
    return held('handoff_evidence_mismatch');
  }
  const observed = await inspectExactShokoFiles({ handoff, readEpisode });
  if (observed.state !== 'shoko_files_identified') return observed;
  try {
    return ledger.recordContentPresent({ attemptId,
      evidenceDigest: handoff.evidenceDigest, publishName: handoff.publishName,
      fileIds: observed.fileIds, nowMs });
  } catch { return held('content_record_unavailable'); }
}
