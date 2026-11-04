import path from 'node:path';
import { verifyStagedFile } from '../identity/verify-staged-file.mjs';
import { verifyStagedSubtitle } from '../identity/verify-staged-subtitle.mjs';
import { makeBytePacer } from '../identity/read-pacer.mjs';
import { torrentFileKind } from './evaluate-stopped-manifest.mjs';

const held = (reason) => ({ state: 'held', reason });

// Diagnostic orchestration only. A later handoff must revalidate immediately
// before exposing any file to Shoko; this function never moves media.
export async function verifyStagedBatch({
  root, request, attempt, expectedTorrent, plannedFiles, observe,
  lookup, verify = verifyStagedFile, verifySubtitle = verifyStagedSubtitle,
  maxTotalBytes = 64 * 1024 ** 3,
  readPacer, readRateBytesPerSecond = 16 * 1024 ** 2,
  ed2kMode,
}) {
  if (typeof root !== 'string' || !path.isAbsolute(root) ||
      !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(expectedTorrent?.hash) ||
      typeof observe !== 'function' || typeof lookup !== 'function' ||
      typeof verify !== 'function' || typeof verifySubtitle !== 'function' ||
      !Number.isSafeInteger(maxTotalBytes) ||
      maxTotalBytes < 1 || maxTotalBytes > 1024 ** 4) {
    throw new TypeError('Invalid staged batch configuration');
  }
  if (readPacer !== undefined && typeof readPacer?.afterBytes !== 'function') {
    throw new TypeError('Invalid staged batch read pacer');
  }
  const pacer = readPacer ?? makeBytePacer({ bytesPerSecond: readRateBytesPerSecond });
  if (request?.status !== 'held' || !Number.isSafeInteger(request.id) || request.id <= 0 ||
      !Number.isSafeInteger(request.anidbId) ||
      request.anidbId <= 0 || !Array.isArray(request.episodeIds) ||
      request.episodeIds.length === 0 || request.episodeIds.length > 2_000 ||
      request.episodeIds.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
      new Set(request.episodeIds).size !== request.episodeIds.length ||
      attempt?.status !== 'torrent_observed' ||
      !Number.isSafeInteger(attempt.id) || attempt.id <= 0 ||
      attempt.requestId !== request.id || attempt.anidbId !== request.anidbId ||
      typeof attempt.torrentHash !== 'string' ||
      attempt.torrentHash.toLowerCase() !== expectedTorrent.hash.toLowerCase() ||
      !Array.isArray(attempt.episodeIds) || attempt.episodeIds.length === 0 ||
      attempt.episodeIds.length > 50 ||
      attempt.episodeIds.some((id) => !Number.isSafeInteger(id) || id <= 0 ||
        !request.episodeIds.includes(id)) ||
      new Set(attempt.episodeIds).size !== attempt.episodeIds.length ||
      !Array.isArray(plannedFiles) || plannedFiles.length === 0 || plannedFiles.length > 50) {
    return held('invalid_batch_plan');
  }
  const plannedByName = new Map();
  const plannedIds = new Set();
  for (const file of plannedFiles) {
    if (typeof file?.name !== 'string' || !file.name || plannedByName.has(file.name) ||
        (file.size !== undefined && (!Number.isSafeInteger(file.size) || file.size < 1)) ||
        !Array.isArray(file.episodeIds) || file.episodeIds.length === 0 ||
        new Set(file.episodeIds).size !== file.episodeIds.length ||
        file.episodeIds.some((id) => !Number.isSafeInteger(id) || id <= 0 ||
          plannedIds.has(id))) return held('invalid_batch_plan');
    plannedByName.set(file.name, file);
    for (const id of file.episodeIds) plannedIds.add(id);
  }
  if (plannedIds.size !== attempt.episodeIds.length ||
      attempt.episodeIds.some((id) => !plannedIds.has(id))) return held('target_coverage_mismatch');

  let first;
  try { first = await observe({ expected: expectedTorrent, phase: 'before_hash' }); }
  catch { return held('torrent_unavailable'); }
  if (first?.state !== 'complete') return held(first?.reason ?? 'torrent_unavailable');
  const selected = first.files;
  const subtitles = first.subtitles ?? [];
  if (!Array.isArray(selected) || selected.length !== plannedFiles.length ||
      selected.length > 50 || selected.some((file) =>
        !Number.isSafeInteger(file?.index) || file.index < 0 ||
        typeof file.name !== 'string' || !plannedByName.has(file.name) ||
        !Number.isSafeInteger(file.size) || file.size <= 0 ||
        (plannedByName.get(file.name).size !== undefined &&
          plannedByName.get(file.name).size !== file.size)) ||
      new Set(selected.map((file) => file.name)).size !== selected.length ||
      selected.reduce((sum, file) => sum + file.size, 0) > maxTotalBytes) {
    return held('manifest_or_budget_mismatch');
  }
  if (!Array.isArray(subtitles) || subtitles.length > 50 ||
    subtitles.reduce((sum, file) => sum + (file?.size ?? 0), 0) > 64 * 1024 ** 2 ||
    subtitles.some((file) =>
    !Number.isSafeInteger(file?.index) || file.index < 0 ||
    torrentFileKind(file.name) !== 'subtitle' ||
    !Number.isSafeInteger(file.size) || file.size < 1 || file.size > 16 * 1024 ** 2) ||
    new Set([...selected, ...subtitles].map((file) => file.index)).size !==
      selected.length + subtitles.length ||
    new Set([...selected, ...subtitles].map((file) => file.name.toLowerCase())).size !==
      selected.length + subtitles.length) return held('manifest_or_budget_mismatch');

  const verified = [];
  const fileIds = new Set();
  for (const file of selected) {
    let result;
    try {
      result = await verify({ root, relativePath: file.name,
        expected: { animeId: request.anidbId, episodeIds: plannedByName.get(file.name).episodeIds },
        lookup, readPacer: pacer, ed2kMode });
    } catch { return held('file_unavailable'); }
    if (result?.state !== 'identity_verified') {
      return held(result?.reason === 'wrong_identity' ? 'file_wrong_identity' :
        `file_${result?.reason ?? 'unavailable'}`);
    }
    if (result.isCorrupted === true) return held('file_corrupt_release');
    if (result.isCorrupted !== false) return held('file_corruption_unverified');
    if (!Number.isSafeInteger(result.fileId) || result.fileId <= 0 ||
        fileIds.has(result.fileId) || result.size !== file.size ||
        !/^[0-9A-F]{32}$/.test(result.ed2k)) return held('invalid_file_evidence');
    const plannedEpisodes = plannedByName.get(file.name).episodeIds;
    if (!Array.isArray(result.coverage) || result.coverage.length !== plannedEpisodes.length ||
        result.coverage.some((range) => !plannedEpisodes.includes(range?.episodeId) ||
          range.start !== 0 || range.end !== 100) ||
        new Set(result.coverage.map((range) => range.episodeId)).size !== plannedEpisodes.length) {
      return held('partial_or_unproved_episode');
    }
    fileIds.add(result.fileId);
    verified.push({ name: file.name, episodeIds: [...plannedByName.get(file.name).episodeIds],
      anidbFileId: result.fileId, ed2k: result.ed2k, size: result.size });
  }

  const verifiedSubtitles = [];
  for (const subtitle of subtitles) {
    let result;
    try {
      result = await verifySubtitle({ root, relativePath: subtitle.name, readPacer: pacer });
    } catch { return held('subtitle_unavailable'); }
    if (result?.state !== 'subtitle_verified' || result.size !== subtitle.size ||
        !/^[0-9A-F]{64}$/.test(result.sha256)) return held('subtitle_unavailable');
    verifiedSubtitles.push({ index: subtitle.index, name: subtitle.name,
      size: subtitle.size, sha256: result.sha256 });
  }

  let final;
  try { final = await observe({ expected: expectedTorrent, phase: 'after_hash' }); }
  catch { return held('torrent_provider_unavailable_after_hash'); }
  if (final?.state === 'held' &&
      ['provider_unavailable', 'provider_timeout', 'provider_transport',
        'provider_http_403', 'provider_http_error', 'provider_invalid_response',
        'authentication_backoff', 'authentication_failed',
        'authentication_forbidden', 'authentication_unavailable',
        'incomplete'].includes(final.reason)) {
    return held(`torrent_${final.reason}_after_hash`);
  }
  const signature = (result) => result?.state === 'complete' && Array.isArray(result.files) &&
      (result.subtitles === undefined || Array.isArray(result.subtitles))
    ? JSON.stringify({ videos: result.files.map((file) => [file.index, file.name, file.size]),
      subtitles: (result.subtitles ?? []).map((file) => [file.index, file.name, file.size]) }) : null;
  if (signature(first) === null || signature(first) !== signature(final)) {
    return held('torrent_changed_after_hash');
  }
  return { state: 'batch_identity_verified', torrentHash: expectedTorrent.hash.toLowerCase(),
    anidbId: request.anidbId,
    files: verified,
    subtitles: verifiedSubtitles,
    handoffReady: false };
}
