import { stagingSavePath } from './staging-save-path.mjs';
import { startStoppedCandidate } from './start-stopped-candidate.mjs';
import { observeStoppedManifest } from './observe-stopped-manifest.mjs';
import { qbittorrentSessionCookie } from './qbittorrent-session-cookie.mjs';

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
      typeof acquisitions?.recordTorrent !== 'function' ||
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
  if (attempt.status === 'dispatch_unknown' && attempt.expectedHash) {
    // The indexer may no longer list the release after qBittorrent accepted
    // it. Reconcile the saved hash from qBittorrent; never send another add.
    const pending = { hash: attempt.expectedHash, category: 'negev',
      savePath: stagingSavePath(attempt.expectedHash,
        { saveRoot: qbitStagingRoot }) };
    let observed = await observeStoppedManifest({
      baseUrl: qbittorrent.baseUrl, sessionId: qbittorrent.sessionId,
      expected: pending, fetchImpl, saveRoot: qbitStagingRoot,
      allowSelectedPassive: true,
    });
    if (observed.state === 'manifest_needs_exclusions') {
      const body = new URLSearchParams({ hash: pending.hash,
        id: observed.passive.map((file) => String(file.index)).join('|'),
        priority: '0' });
      try {
        await fetchImpl(new URL('/api/v2/torrents/filePrio', qbittorrent.baseUrl), {
          method: 'POST', headers: { Cookie: qbittorrentSessionCookie(qbittorrent.sessionId),
            'Content-Type': 'application/x-www-form-urlencoded' },
          body, redirect: 'manual', signal: AbortSignal.timeout(10_000),
        });
      } catch { /* Re-observe the exact stopped torrent after an uncertain response. */ }
      observed = await observeStoppedManifest({
        baseUrl: qbittorrent.baseUrl, sessionId: qbittorrent.sessionId,
        expected: pending, fetchImpl, saveRoot: qbitStagingRoot,
      });
    }
    if (observed.state !== 'manifest_safe') return observed;
    const signature = (files) => JSON.stringify(files.map((file) =>
      [file.name, file.size]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    if (!plan || signature(observed.videos) !== signature(plan)) {
      return held('file_plan_mismatch');
    }
    let recorded;
    try { recorded = acquisitions.recordTorrent({ attemptId,
      hash: attempt.expectedHash, nowMs: now() }); }
    catch { return held('attempt_unavailable'); }
    if (recorded.state !== 'torrent_observed') return recorded;
    attempt = acquisitions.getAttempt(attemptId);
  }
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
