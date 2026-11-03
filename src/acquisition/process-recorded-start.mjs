import { stagingSavePath } from './staging-save-path.mjs';
import { startStoppedCandidate } from './start-stopped-candidate.mjs';

const held = (reason) => ({ state: 'held', reason });

// Explicit one-attempt continuation. Identity, hash and file plan come from
// the durable acquisition journal, never from a caller-supplied title or URL.
// The start gate still rechecks stopped qBittorrent, staging and absence proof.
export async function processRecordedStart({ attemptId, requests, acquisitions,
  stagingHostPath, qbitStagingRoot, qbittorrent, inspectMounts,
  verifyStagingRoot, realpathImpl, readEvidence,
  publicLibraryIds, fetchImpl = fetch, now = Date.now,
  start = startStoppedCandidate } = {}) {
  if (!Number.isSafeInteger(attemptId) || attemptId < 1 ||
      typeof requests?.getRequest !== 'function' ||
      typeof acquisitions?.getAttempt !== 'function' ||
      typeof acquisitions?.getFilePlan !== 'function' ||
      typeof acquisitions?.getStart !== 'function' ||
      typeof stagingHostPath !== 'string' || !stagingHostPath ||
      typeof qbittorrent?.baseUrl !== 'string' ||
      typeof qbittorrent?.sessionId !== 'string' ||
      (typeof verifyStagingRoot !== 'function' &&
        (typeof inspectMounts !== 'function' || typeof realpathImpl !== 'function')) ||
      typeof readEvidence !== 'function' ||
      !Array.isArray(publicLibraryIds) || publicLibraryIds.length < 1 ||
      typeof fetchImpl !== 'function' || typeof now !== 'function' ||
      typeof start !== 'function') {
    throw new TypeError('Invalid recorded start');
  }
  let attempt, plan, intent;
  try {
    attempt = acquisitions.getAttempt(attemptId);
    if (!attempt) return held('attempt_missing');
    intent = acquisitions.getStart(attemptId);
    if (intent) return { state: intent.status, sendNow: false };
    plan = acquisitions.getFilePlan(attemptId);
  } catch { return held('attempt_unavailable'); }
  if (attempt.status !== 'torrent_observed' || !attempt.torrentHash) {
    return held('torrent_not_observed');
  }
  if (!plan) return held('file_plan_missing');
  const expected = { hash: attempt.torrentHash, category: 'negev',
    savePath: stagingSavePath(attempt.torrentHash,
      { saveRoot: qbitStagingRoot }) };
  return start({ ledger: acquisitions, attemptId, expected,
    hostPath: stagingHostPath, inspectMounts, verifyStagingRoot, realpathImpl,
    saveRoot: qbitStagingRoot,
    baseUrl: qbittorrent.baseUrl, sessionId: qbittorrent.sessionId,
    readRequest: (id) => requests.getRequest(id), readEvidence,
    publicLibraryIds, fetchImpl, now });
}
