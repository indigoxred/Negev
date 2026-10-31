import path from 'node:path';
import { verifyStagedFile } from '../identity/verify-staged-file.mjs';
import { makeBytePacer } from '../identity/read-pacer.mjs';

const held = (reason) => ({ state: 'held', reason });

// Diagnostic orchestration only. A later handoff must revalidate immediately
// before exposing any file to Shoko; this function never moves media.
export async function verifyStagedBatch({
  root, request, expectedTorrent, plannedFiles, observe,
  lookup, verify = verifyStagedFile, maxTotalBytes = 64 * 1024 ** 3,
  readPacer, readRateBytesPerSecond = 16 * 1024 ** 2,
}) {
  if (typeof root !== 'string' || !path.isAbsolute(root) ||
      typeof observe !== 'function' || typeof lookup !== 'function' ||
      typeof verify !== 'function' || !Number.isSafeInteger(maxTotalBytes) ||
      maxTotalBytes < 1 || maxTotalBytes > 1024 ** 4) {
    throw new TypeError('Invalid staged batch configuration');
  }
  if (readPacer !== undefined && typeof readPacer?.afterBytes !== 'function') {
    throw new TypeError('Invalid staged batch read pacer');
  }
  const pacer = readPacer ?? makeBytePacer({ bytesPerSecond: readRateBytesPerSecond });
  if (request?.status !== 'held' || !Number.isSafeInteger(request.anidbId) ||
      request.anidbId <= 0 || !Array.isArray(request.episodeIds) ||
      request.episodeIds.length === 0 || request.episodeIds.length > 500 ||
      request.episodeIds.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
      new Set(request.episodeIds).size !== request.episodeIds.length ||
      !Array.isArray(plannedFiles) || plannedFiles.length === 0 || plannedFiles.length > 50) {
    return held('invalid_batch_plan');
  }
  const plannedByName = new Map();
  const plannedIds = new Set();
  for (const file of plannedFiles) {
    if (typeof file?.name !== 'string' || !file.name || plannedByName.has(file.name) ||
        !Array.isArray(file.episodeIds) || file.episodeIds.length === 0 ||
        file.episodeIds.some((id) => !Number.isSafeInteger(id) || id <= 0 ||
          plannedIds.has(id))) return held('invalid_batch_plan');
    plannedByName.set(file.name, file);
    for (const id of file.episodeIds) plannedIds.add(id);
  }
  if (plannedIds.size !== request.episodeIds.length ||
      request.episodeIds.some((id) => !plannedIds.has(id))) return held('target_coverage_mismatch');

  let first;
  try { first = await observe({ expected: expectedTorrent }); }
  catch { return held('torrent_unavailable'); }
  if (first?.state !== 'complete') return held(first?.reason ?? 'torrent_unavailable');
  const selected = first.files;
  if (!Array.isArray(selected) || selected.length !== plannedFiles.length ||
      selected.length > 50 || selected.some((file) =>
        !Number.isSafeInteger(file?.index) || file.index < 0 ||
        typeof file.name !== 'string' || !plannedByName.has(file.name) ||
        !Number.isSafeInteger(file.size) || file.size <= 0) ||
      new Set(selected.map((file) => file.name)).size !== selected.length ||
      selected.reduce((sum, file) => sum + file.size, 0) > maxTotalBytes) {
    return held('manifest_or_budget_mismatch');
  }

  const verified = [];
  const fileIds = new Set();
  for (const file of selected) {
    let result;
    try {
      result = await verify({ root, relativePath: file.name,
        expected: { animeId: request.anidbId, episodeIds: plannedByName.get(file.name).episodeIds },
        lookup, readPacer: pacer });
    } catch { return held('file_unavailable'); }
    if (result?.state !== 'identity_verified') {
      return held(result?.reason === 'wrong_identity' ? 'file_wrong_identity' :
        `file_${result?.reason ?? 'unavailable'}`);
    }
    if (!Number.isSafeInteger(result.fileId) || result.fileId <= 0 ||
        fileIds.has(result.fileId) || result.size !== file.size ||
        !/^[0-9A-F]{32}$/.test(result.ed2k)) return held('invalid_file_evidence');
    fileIds.add(result.fileId);
    verified.push({ name: file.name, episodeIds: [...plannedByName.get(file.name).episodeIds],
      anidbFileId: result.fileId, ed2k: result.ed2k, size: result.size });
  }

  let final;
  try { final = await observe({ expected: expectedTorrent }); }
  catch { return held('torrent_changed_after_hash'); }
  const signature = (result) => result?.state === 'complete' && Array.isArray(result.files) &&
      (result.subtitles === undefined || Array.isArray(result.subtitles))
    ? JSON.stringify({ videos: result.files.map((file) => [file.index, file.name, file.size]),
      subtitles: (result.subtitles ?? []).map((file) => [file.index, file.name, file.size]) }) : null;
  if (signature(first) === null || signature(first) !== signature(final)) {
    return held('torrent_changed_after_hash');
  }
  return { state: 'batch_identity_verified', files: verified, handoffReady: false };
}
