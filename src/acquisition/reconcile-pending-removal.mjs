import { retirePrestartMismatchAbsent } from './retire-prestart-mismatch-absent.mjs';
import { retireStalledAbsent } from './retire-stalled-absent.mjs';

// A review recheck has no delete capability. The original one-send intent
// remains authoritative until both downloader absence and empty staging agree.
export async function reconcilePendingRemoval({ ledger, attemptId, sessionGate,
  now = Date.now, authorizeAction, ...providers }) {
  if (!Number.isSafeInteger(attemptId) || attemptId < 1 ||
      typeof ledger?.getAttempt !== 'function' || typeof ledger.getStart !== 'function' ||
      typeof ledger.getStalledRetirementIntent !== 'function' ||
      typeof sessionGate?.get !== 'function' || typeof now !== 'function' || typeof authorizeAction !== 'function') {
    throw new TypeError('Invalid removal recheck');
  }
  const attempt = ledger.getAttempt(attemptId);
  const intent = ledger.getStalledRetirementIntent(attemptId);
  if (attempt?.status !== 'torrent_observed' || intent?.status !== 'delete_unknown' ||
      intent.hash !== attempt.torrentHash || intent.hash !== attempt.expectedHash) {
    return { state: 'held', reason: 'not_in_review' };
  }
  let session;
  try { session = await sessionGate.get(); }
  catch { return { state: 'held', reason: 'authentication_unavailable' }; }
  if (session?.state !== 'authenticated') return { state: 'held', reason: 'authentication_unavailable' };
  const reconcile = ledger.getStart(attemptId) ? retireStalledAbsent : retirePrestartMismatchAbsent;
  return reconcile({ ...providers, ledger, attemptId, sessionId: session.sessionId, authorizeRetirement:authorizeAction, nowMs: now() });
}
