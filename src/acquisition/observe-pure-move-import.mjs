import { localPath, validMount } from '../availability/known-card-availability.mjs';
import { probePhysicalCandidate } from '../availability/physical-plex-part.mjs';

const held = (reason) => ({ state: 'held', reason });
const validId = (value) => Number.isSafeInteger(value) && value > 0;
const sameIds = (left, right) => Array.isArray(left) &&
  left.length === right.length && new Set(left).size === left.length &&
  left.every((id) => right.includes(id));

// A Shoko episode already in the library may have the same title and size as
// a new handoff. Only the physical inode recorded before the pure move can
// associate Shoko's file ID with this attempt, without rehashing the video.
export async function observePureMoveImport({ move, target, shokoMount,
  readEpisode, probeImpl = probePhysicalCandidate } = {}) {
  if (move?.status !== 'published_observed') return held('publish_not_observed');
  const manifestFiles = move.manifest?.files;
  const files = Array.isArray(manifestFiles) ? manifestFiles.filter((file) =>
    Array.isArray(file.episodeIds)) : null;
  if (!validId(target?.anidbId) || !Array.isArray(target.episodeIds) ||
      target.episodeIds.length < 1 || target.episodeIds.length > 100 ||
      target.episodeIds.some((id) => !validId(id)) ||
      !Array.isArray(files) || files.length < 1 || files.length > 100 ||
      files.some((file) => !Array.isArray(file.episodeIds) ||
        file.episodeIds.length < 1 || file.episodeIds.some((id) => !validId(id)) ||
        !validId(file.size) || !/^\d+$/.test(file.dev) ||
        !/^\d+$/.test(file.ino)) ||
      !sameIds([...new Set(files.flatMap((file) => file.episodeIds))],
        target.episodeIds) || !validMount(shokoMount) ||
      typeof readEpisode !== 'function' || typeof probeImpl !== 'function') {
    throw new TypeError('Invalid pure import observation');
  }
  const episodes = new Map();
  for (const episodeId of target.episodeIds) {
    let result;
    try { result = await readEpisode({ anidbId: target.anidbId, episodeId }); }
    catch { return held('shoko_unavailable'); }
    if (result?.state === 'not_imported') return { state: 'awaiting_shoko', episodeId };
    if (result?.state !== 'ok' || result.complete !== true ||
        !Array.isArray(result.files) || result.files.length > 50) {
      return held('shoko_unavailable');
    }
    episodes.set(episodeId, result.files);
  }
  const observed = [];
  const usedIds = new Set();
  for (const expected of files) {
    const candidates = episodes.get(expected.episodeIds[0]).filter((file) =>
      validId(file?.fileId) && file.anidbId === target.anidbId &&
      file.size === expected.size && sameIds(file.episodeIds, expected.episodeIds) &&
      expected.episodeIds.every((id) => file.coverage?.some((range) =>
        range.episodeId === id && range.start === 0 && range.end === 100)) &&
      Array.isArray(file.sourcePaths) && file.sourcePaths.length > 0 &&
      file.sourcePaths.length <= 20);
    const matching = new Map();
    for (const file of candidates) {
      for (const source of file.sourcePaths) {
        const filePath = localPath(source, shokoMount);
        if (!filePath) continue;
        let probe;
        try { probe = await probeImpl({ filePath,
          allowedRoot: shokoMount.localRoot, expectedSize: expected.size }); }
        catch { continue; }
        if (probe?.state === 'candidate' &&
            probe.candidateKey === `${expected.dev}:${expected.ino}:${expected.size}`) {
          matching.set(file.fileId, file);
        }
      }
    }
    if (matching.size === 0) return { state: 'awaiting_shoko',
      episodeId: expected.episodeIds[0] };
    if (matching.size !== 1) return held('ambiguous_shoko_file');
    const file = [...matching.values()][0];
    for (const episodeId of expected.episodeIds.slice(1)) {
      if (!episodes.get(episodeId).some((other) =>
        other.fileId === file.fileId && other.anidbId === file.anidbId &&
        other.size === file.size &&
        sameIds(other.episodeIds, expected.episodeIds) &&
        other.coverage?.some((range) =>
          range.episodeId === episodeId && range.start === 0 && range.end === 100))) {
        return { state: 'awaiting_shoko', episodeId };
      }
    }
    if (usedIds.has(file.fileId)) return held('ambiguous_shoko_file');
    usedIds.add(file.fileId);
    observed.push({ name: expected.name, fileId: file.fileId,
      releaseEvidence: file.releaseEvidence ?? 'registered' });
  }
  return { state: 'shoko_files_identified', files: observed };
}
