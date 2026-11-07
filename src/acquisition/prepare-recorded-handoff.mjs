import { rm } from 'node:fs/promises';
import path from 'node:path';
import { verifyRecordedBatch } from './verify-recorded-batch.mjs';
import { prepareHandoffBatch } from './prepare-handoff-batch.mjs';

const held = (reason) => ({ state: 'held', reason });

// This stops at private holding. Publishing to watched Shoko Import is a
// separate, durable operation and must be explicitly reconciled afterward.
export async function prepareRecordedHandoff({
  requests, acquisitions, handoffs, attemptId,
  stagingHostPath, qbitStagingRoot, holdingRoot, importRoot, observe, lookup,
  nowMs, verify, verifySubtitle, readPacer, ed2kMode,
  allowProvisional = false,
  verifyHandoffMounts,
  verifyStagingRoot,
}) {
  if (typeof handoffs?.getHandoff !== 'function' ||
      typeof handoffs?.recordPrepared !== 'function' ||
      typeof acquisitions?.recordTerminalRejection !== 'function' ||
      !Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new TypeError('Invalid handoff coordinator configuration');
  }
  if (handoffs.getHandoff(attemptId)) return held('handoff_already_recorded');
  const verified = await verifyRecordedBatch({ requests, acquisitions, attemptId,
    stagingHostPath, qbitStagingRoot, observe, lookup, verify, verifySubtitle, readPacer,
    ed2kMode, allowProvisional });
  if (verified.state === 'held' && verified.reason === 'file_wrong_identity') {
    const attempt = acquisitions.getAttempt(attemptId);
    return acquisitions.recordTerminalRejection({ attemptId,
      hash: attempt.torrentHash, reason: verified.reason, nowMs });
  }
  if (!['batch_identity_verified', 'batch_provisional'].includes(verified.state)) {
    return verified;
  }
  if (verifyStagingRoot) {
    try {
      const result = await verifyStagingRoot();
      if (result !== true && result?.state !== 'verified_staging_root') {
        return held('staging_root_unverified');
      }
    } catch { return held('staging_root_unverified'); }
  }
  const stagingRoot = path.join(stagingHostPath, verified.torrentHash);
  const prepared = await prepareHandoffBatch({ stagingRoot, holdingRoot, importRoot,
    verified, readPacer, verifyHandoffMounts, ed2kMode });
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
