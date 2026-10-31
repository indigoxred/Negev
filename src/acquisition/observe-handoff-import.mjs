import { evaluateHandoffEvidence } from './handoff-evidence.mjs';

const held = (reason) => ({ state: 'held', reason });
const validId = (value) => Number.isSafeInteger(value) && value > 0;
const sameIds = (left, right) => Array.isArray(left) &&
  left.length === right.length && left.every((id) => right.includes(id));

// Read-only, bounded check of a previously published handoff. A positive
// result proves Shoko has identified each exact registered video and has an
// accessible location. It does not prove Plex playback or subtitle import.
export async function observeHandoffImport({ handoff, readEpisode } = {}) {
  if (handoff?.status !== 'published_observed') return held('publish_not_observed');
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
      const prior = observed.get(expected.anidbFileId);
      if (prior !== undefined && prior !== file.fileId) {
        return held('inconsistent_shoko_file');
      }
      observed.set(expected.anidbFileId, file.fileId);
    }
  }
  return { state: 'shoko_import_observed',
    fileIds: manifest.videos.map((file) => observed.get(file.anidbFileId)) };
}
