import { publishPreparedHandoff } from './publish-handoff-batch.mjs';
import { restorePreparedHandoff } from './restore-prepared-handoff.mjs';

// Explicit, one-attempt continuation. Only the journal supplies the batch;
// the low-level publisher still revalidates paths, bytes and AniDB release
// identity before any watched-folder rename. No timer calls this yet.
export async function processRecordedHandoff({ attemptId, ledger, ...providers } = {}) {
  if (!Number.isSafeInteger(attemptId) || attemptId < 1 ||
      typeof ledger?.getHandoff !== 'function') {
    throw new TypeError('Invalid recorded handoff');
  }
  let handoff;
  try { handoff = ledger.getHandoff(attemptId); }
  catch { return { state: 'held', reason: 'handoff_unavailable' }; }
  if (!handoff) return { state: 'held', reason: 'handoff_missing' };
  const prepared = restorePreparedHandoff({ attemptId, handoff });
  if (prepared.state !== 'handoff_prepared') return prepared;
  return publishPreparedHandoff({ ...providers, attemptId, ledger, prepared });
}
