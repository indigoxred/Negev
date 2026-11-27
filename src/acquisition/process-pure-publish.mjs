import path from 'node:path';
import { preparePureMove } from './pure-move-handoff.mjs';
import { publishPureMove } from './publish-pure-move.mjs';
import { observePureMoveImport } from './observe-pure-move-import.mjs';

import { heldReporter } from '../runtime/held-diagnostics.mjs';
const held = (reason) => ({ state: 'held', reason });
const heldAfter = heldReporter('acquisition/process-pure-publish');

export async function processPurePublish({ attemptId, nowMs, pureMoves,
  stagingHostPath, holdingRoot, importRoot, target, shokoMount, readEpisode,
  prepare = preparePureMove, publish = publishPureMove,
  observe = observePureMoveImport } = {}) {
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
  const result = await publish({ attemptId, ledger: pureMoves,
    holdingRoot, importRoot, nowMs });
  if (result?.reason !== 'published_tree_absent' ||
      row.status !== 'publish_unknown') return result;
  if (!target || !shokoMount || typeof readEpisode !== 'function' ||
      typeof pureMoves.recordContentPresent !== 'function') {
    return held('publish_outcome_unknown');
  }
  let observed;
  try { observed = await observe({ move: row, target, shokoMount,
    readEpisode }); }
  catch (error) { return heldAfter(error, 'publish_outcome_unknown'); }
  if (observed?.state !== 'shoko_files_identified') {
    return observed?.reason === 'ambiguous_shoko_file'
      ? observed : held('publish_outcome_unknown');
  }
  try {
    const saved = pureMoves.recordContentPresent({ attemptId,
      files: observed.files, nowMs });
    return saved?.state === 'content_present'
      ? held('content_present_unattributed') : held('publish_outcome_unknown');
  } catch (error) { return heldAfter(error, 'publish_outcome_unknown'); }
}
