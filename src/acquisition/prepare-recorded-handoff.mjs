import { rm } from 'node:fs/promises';
import { verifyRecordedBatch } from './verify-recorded-batch.mjs';
import { prepareHandoffBatch } from './prepare-handoff-batch.mjs';

const held = (reason) => ({ state: 'held', reason });

// This stops at private holding. Publishing to watched Shoko Import is a
// separate, durable operation and must be explicitly reconciled afterward.
export async function prepareRecordedHandoff({
  requests, acquisitions, handoffs, attemptId,
  stagingRoot, holdingRoot, importRoot, observe, lookup,
  nowMs, verify, verifySubtitle, readPacer,
}) {
  if (typeof handoffs?.getHandoff !== 'function' ||
      typeof handoffs?.recordPrepared !== 'function' ||
      !Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new TypeError('Invalid handoff coordinator configuration');
  }
  if (handoffs.getHandoff(attemptId)) return held('handoff_already_recorded');
  const verified = await verifyRecordedBatch({ requests, acquisitions, attemptId,
    root: stagingRoot, observe, lookup, verify, verifySubtitle, readPacer });
  if (verified.state !== 'batch_identity_verified') return verified;
  const prepared = await prepareHandoffBatch({ stagingRoot, holdingRoot, importRoot,
    verified, readPacer });
  if (prepared.state !== 'handoff_prepared') return prepared;
  let saved;
  try {
    saved = handoffs.recordPrepared({ attemptId, prepared, nowMs });
    if (saved.state === 'prepared' &&
        handoffs.getHandoff(attemptId)?.holdingPath === prepared.holdingPath) {
      return { ...prepared, publishName: saved.publishName };
    }
  } catch { /* A failed journal write must not leave an untracked private copy. */ }
  await rm(prepared.holdingPath, { recursive: true, force: true });
  return held(saved?.reason ?? 'handoff_record_unavailable');
}
