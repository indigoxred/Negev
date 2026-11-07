import path from 'node:path';
import { verifyStagedBatch } from './verify-staged-batch.mjs';
import { stagingSavePath } from './staging-save-path.mjs';

const held = (reason) => ({ state: 'held', reason });

// Recover the exact saved request, attempt, and provisional filename plan
// before hashing. A caller may supply observers, but cannot replace that plan.
export async function verifyRecordedBatch({ requests, acquisitions, attemptId,
  stagingHostPath, qbitStagingRoot, observe, lookup, verify, verifySubtitle, readPacer,
  ed2kMode, allowProvisional = false }) {
  if (!Number.isSafeInteger(attemptId) || attemptId < 1 ||
      typeof stagingHostPath !== 'string' || !path.isAbsolute(stagingHostPath) ||
      path.resolve(stagingHostPath) !== stagingHostPath ||
      typeof requests?.getRequest !== 'function' ||
      typeof acquisitions?.getAttempt !== 'function' ||
      typeof acquisitions?.getFilePlan !== 'function' ||
      typeof acquisitions?.getStart !== 'function') {
    throw new TypeError('Invalid recorded batch configuration');
  }
  const attempt = acquisitions.getAttempt(attemptId);
  if (!attempt || attempt.status !== 'torrent_observed' || !attempt.torrentHash) {
    return held('torrent_not_observed');
  }
  const start = acquisitions.getStart(attemptId);
  if (!start || start.torrentHash !== attempt.torrentHash) return held('start_not_recorded');
  const plannedFiles = acquisitions.getFilePlan(attemptId);
  if (!plannedFiles) return held('file_plan_missing');
  const request = requests.getRequest(attempt.requestId);
  if (!request) return held('request_missing');
  const root = path.join(stagingHostPath, attempt.torrentHash);
  return verifyStagedBatch({ root, request, attempt,
    expectedTorrent: { hash: attempt.torrentHash, category: 'negev',
      savePath: stagingSavePath(attempt.torrentHash,
        { saveRoot: qbitStagingRoot }) },
    plannedFiles, observe, lookup, verify, verifySubtitle, readPacer,
    ed2kMode, allowProvisional });
}
