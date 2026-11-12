import path from 'node:path';
import { preparePureMove } from './pure-move-handoff.mjs';
import { publishPureMove } from './publish-pure-move.mjs';

const held = (reason) => ({ state: 'held', reason });

export async function processPurePublish({ attemptId, nowMs, pureMoves,
  stagingHostPath, holdingRoot, importRoot,
  prepare = preparePureMove, publish = publishPureMove } = {}) {
  if (!Number.isSafeInteger(attemptId) || attemptId < 1 ||
      !Number.isSafeInteger(nowMs) || nowMs < 0 ||
      typeof pureMoves?.getIntent !== 'function' ||
      typeof stagingHostPath !== 'string' || !path.isAbsolute(stagingHostPath) ||
      typeof holdingRoot !== 'string' || !path.isAbsolute(holdingRoot) ||
      typeof importRoot !== 'string' || !path.isAbsolute(importRoot) ||
      typeof prepare !== 'function' || typeof publish !== 'function') {
    throw new TypeError('Invalid pure publish coordinator');
  }
  const row = pureMoves.getIntent(attemptId);
  if (!row) return held('move_intent_missing');
  const manifest = row.manifest;
  if (manifest?.attemptId !== attemptId ||
      path.normalize(manifest.stagingRoot ?? '') !==
        path.join(stagingHostPath, manifest.torrentHash ?? '') ||
      path.normalize(path.dirname(manifest.holdingPath ?? '')) !==
        path.normalize(holdingRoot)) {
    return held('move_intent_conflict');
  }
  if (row.status === 'moving') {
    const result = await prepare({ attemptId, torrentHash: manifest.torrentHash,
      stagingRoot: manifest.stagingRoot, holdingRoot, importRoot,
      files: manifest.files,
      recordIntent: (intent) => pureMoves.recordIntent({ ...intent, nowMs }) });
    if (result?.state !== 'prepared') return result ?? held('move_outcome_unknown');
    const saved = pureMoves.markPrepared({ attemptId, nowMs });
    if (saved?.state !== 'prepared') return held('move_outcome_unknown');
  }
  return publish({ attemptId, ledger: pureMoves, holdingRoot, importRoot, nowMs });
}
