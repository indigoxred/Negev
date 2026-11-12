import path from 'node:path';
import { stagingSavePath } from './staging-save-path.mjs';
import { stopCompletedTorrent } from './stop-completed-torrent.mjs';
import { preparePureMove } from './pure-move-handoff.mjs';

const held = (reason) => ({ state: 'held', reason });

// A completed torrent is stopped before anything touches its files. The
// exact selected qBittorrent manifest must equal the saved episode plan; the
// file move has its own durable intent. Shoko performs the content hash later.
export async function processPureCompletedAttempt({ requests, acquisitions,
  pureMoves, attemptId, nowMs, stagingHostPath, qbitStagingRoot,
  holdingRoot, importRoot, qbittorrent, fetchImpl = fetch,
  verifyStagingRoot, verifyHandoffMounts,
  stop = stopCompletedTorrent, prepare = preparePureMove } = {}) {
  if (!Number.isSafeInteger(attemptId) || attemptId < 1 ||
      !Number.isSafeInteger(nowMs) || nowMs < 0 ||
      typeof requests?.getRequest !== 'function' ||
      typeof acquisitions?.getAttempt !== 'function' ||
      typeof acquisitions?.getStart !== 'function' ||
      typeof acquisitions?.getFilePlan !== 'function' ||
      typeof pureMoves?.getIntent !== 'function' ||
      typeof pureMoves?.recordIntent !== 'function' ||
      typeof pureMoves?.markPrepared !== 'function' ||
      [stagingHostPath, qbitStagingRoot, holdingRoot, importRoot]
        .some((value) => typeof value !== 'string' || !path.isAbsolute(value)) ||
      typeof verifyStagingRoot !== 'function' ||
      typeof verifyHandoffMounts !== 'function' ||
      typeof stop !== 'function' || typeof prepare !== 'function') {
    throw new TypeError('Invalid pure completion configuration');
  }
  if (pureMoves.getIntent(attemptId)) return held('handoff_already_recorded');
  let attempt, request, start, plan;
  try {
    attempt = acquisitions.getAttempt(attemptId);
    request = requests.getRequest(attempt?.requestId);
    start = acquisitions.getStart(attemptId);
    plan = acquisitions.getFilePlan(attemptId);
  } catch { return held('attempt_unavailable'); }
  if (attempt?.status !== 'torrent_observed' ||
      !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(attempt.torrentHash) ||
      start?.torrentHash !== attempt.torrentHash ||
      request?.id !== attempt.requestId || request.status !== 'held' ||
      request.anidbId !== attempt.anidbId ||
      !Array.isArray(plan) || plan.length < 1 || plan.length > 50) {
    return held('invalid_batch_plan');
  }
  const planned = new Map();
  const targetIds = new Set();
  for (const file of plan) {
    if (typeof file?.name !== 'string' || planned.has(file.name) ||
        !Array.isArray(file.episodeIds) || file.episodeIds.length < 1 ||
        file.episodeIds.some((id) => !Number.isSafeInteger(id) || id < 1 ||
          targetIds.has(id))) return held('invalid_batch_plan');
    planned.set(file.name, file);
    for (const id of file.episodeIds) targetIds.add(id);
  }
  if (!Array.isArray(attempt.episodeIds) || targetIds.size !== attempt.episodeIds.length ||
      attempt.episodeIds.some((id) => !targetIds.has(id))) {
    return held('target_coverage_mismatch');
  }
  let staging, mount;
  try {
    [staging, mount] = await Promise.all([verifyStagingRoot(),
      verifyHandoffMounts({ holdingRoot, importRoot })]);
  } catch { return held('handoff_mount_unavailable'); }
  if (staging?.state !== 'verified_staging_root' ||
      mount?.state !== 'mounted_handoff_roots') return held('handoff_mount_unavailable');
  const expected = { hash: attempt.torrentHash, category: 'negev',
    savePath: stagingSavePath(attempt.torrentHash, { saveRoot: qbitStagingRoot }) };
  const completed = await stop({ baseUrl: qbittorrent.baseUrl,
    sessionId: qbittorrent.sessionId, expected, fetchImpl });
  if (completed?.state !== 'complete') return completed ?? held('torrent_unavailable');
  if (!Array.isArray(completed.files) || completed.files.length !== plan.length ||
      completed.files.some((file) => !planned.has(file.name) ||
        (planned.get(file.name).size !== undefined &&
          planned.get(file.name).size !== file.size)) ||
      new Set(completed.files.map((file) => file.name)).size !== plan.length ||
      !Array.isArray(completed.subtitles) || completed.subtitles.length > 50) {
    return held('manifest_or_budget_mismatch');
  }
  const files = [...completed.files.map((file) => ({ name: file.name,
    size: file.size, episodeIds: [...planned.get(file.name).episodeIds] })),
  ...completed.subtitles.map((file) => ({ name: file.name, size: file.size }))];
  const result = await prepare({ attemptId, torrentHash: attempt.torrentHash,
    stagingRoot: path.join(stagingHostPath, attempt.torrentHash),
    holdingRoot, importRoot, files,
    recordIntent: (intent) => pureMoves.recordIntent({ ...intent, nowMs }) });
  if (result?.state !== 'prepared') return result ?? held('move_outcome_unknown');
  const saved = pureMoves.markPrepared({ attemptId, nowMs });
  return saved?.state === 'prepared' ? { state: 'handoff_prepared' } :
    held('move_outcome_unknown');
}
