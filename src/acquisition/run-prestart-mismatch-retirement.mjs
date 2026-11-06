import { deletePrestartMismatchTorrent } from './delete-prestart-mismatch-torrent.mjs';
import { retirePrestartMismatchAbsent } from './retire-prestart-mismatch-absent.mjs';

const held = (reason) => ({ state: 'held', reason });

// Explicit operator operation. A failed check before the one-send boundary
// cancels the intent; an uncertain delete is reconciled, never repeated.
export async function runPrestartMismatchRetirement({ ledger, attemptId, hash,
  baseUrl, stagingRoot, saveRoot, verifyStagingRoot, sessionGate,
  now = Date.now, deleteImpl = deletePrestartMismatchTorrent,
  reconcileImpl = retirePrestartMismatchAbsent } = {}) {
  if (!Number.isSafeInteger(attemptId) || attemptId < 1 ||
      typeof hash !== 'string' ||
      !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(hash) ||
      typeof ledger?.getAttempt !== 'function' ||
      typeof ledger?.requestPrestartMismatchRetirement !== 'function' ||
      typeof ledger?.getStalledRetirementIntent !== 'function' ||
      typeof ledger?.cancelStalledRetirement !== 'function' ||
      typeof sessionGate?.get !== 'function' ||
      typeof verifyStagingRoot !== 'function' || typeof now !== 'function' ||
      typeof deleteImpl !== 'function' || typeof reconcileImpl !== 'function') {
    throw new TypeError('Invalid prestart mismatch retirement operation');
  }
  const normalizedHash = hash.toLowerCase();
  const attempt = ledger.getAttempt(attemptId);
  if (attempt?.id !== attemptId || attempt.status !== 'torrent_observed' ||
      attempt.expectedHash !== normalizedHash ||
      attempt.torrentHash !== normalizedHash) return held('attempt_mismatch');
  let session, root;
  try {
    session = await sessionGate.get();
    root = await verifyStagingRoot();
  } catch { return held('retirement_preflight_unavailable'); }
  if (session?.state !== 'authenticated') return held('provider_unavailable');
  if (root?.state !== 'verified_staging_root') {
    return held('staging_root_unverified');
  }
  let nowMs;
  try { nowMs = now(); }
  catch { return held('retirement_clock_unavailable'); }
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    return held('retirement_clock_unavailable');
  }
  let requested;
  try { requested = ledger.requestPrestartMismatchRetirement({
    attemptId, hash: normalizedHash, nowMs }); }
  catch { return held('retirement_ledger_unavailable'); }
  if (!['retirement_requested', 'delete_unknown'].includes(requested?.state)) {
    return requested?.state === 'held' ? requested : held('retirement_ledger_unavailable');
  }
  const args = { ledger, attemptId, baseUrl,
    sessionId: session.sessionId, stagingRoot, saveRoot,
    verifyStagingRoot, nowMs };
  let deletion;
  try { deletion = await deleteImpl(args); }
  catch {
    try {
      if (ledger.getStalledRetirementIntent(attemptId)?.status === 'requested') {
        ledger.cancelStalledRetirement({ attemptId, hash: normalizedHash });
      }
    } catch { /* Keep the claim held if the journal cannot be read. */ }
    return held('delete_observation_unavailable');
  }
  if (deletion?.state !== 'delete_unknown') {
    if (requested.state === 'retirement_requested' && deletion?.state === 'held') {
      try { ledger.cancelStalledRetirement({ attemptId, hash: normalizedHash }); }
      catch { return held('retirement_ledger_unavailable'); }
    }
    return deletion?.state === 'held' ? deletion : held('delete_observation_unavailable');
  }
  try { return await reconcileImpl(args); }
  catch { return held('retirement_reconciliation_unavailable'); }
}
