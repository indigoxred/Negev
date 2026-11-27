import { preserveRequestedFiles } from './preserve-requested-files.mjs';
import { constants } from 'node:fs';
import { lstat, open, realpath, rename } from 'node:fs/promises';
import path from 'node:path';
import { inspectPureMoveTree } from './publish-pure-move.mjs';

import { heldReporter } from '../runtime/held-diagnostics.mjs';
const held = (reason) => ({ state: 'held', reason });
const heldAfter = heldReporter('acquisition/preserve-unrecognized-tree');
const validId = (value) => Number.isSafeInteger(value) && value > 0;

async function status(filePath) {
  try { return await lstat(filePath, { bigint: true }); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

async function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  const handle = await open(directory,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try { await handle.sync(); }
  finally { await handle.close(); }
}

// A whole-tree rename preserves the unrecognized video and its subtitles
// without another media read or a copy. The saved inode manifest resolves a
// crash immediately after rename; a changed or partially consumed tree holds.
export async function preserveUnrecognizedTree({ manifest, importRoot,
  holdingRoot, fileId, recheck, renameTree = rename } = {}) {
  if (!validId(manifest?.attemptId) ||
      !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(manifest.torrentHash) ||
      !Array.isArray(manifest.files) || manifest.files.length < 1 ||
      typeof importRoot !== 'string' || !path.isAbsolute(importRoot) ||
      typeof holdingRoot !== 'string' || !path.isAbsolute(holdingRoot) ||
      path.normalize(importRoot) !== importRoot ||
      path.normalize(holdingRoot) !== holdingRoot ||
      typeof recheck !== 'function' || typeof renameTree !== 'function') {
    throw new TypeError('Invalid unrecognized preservation');
  }
  const name = `negev-${manifest.attemptId}-${manifest.torrentHash.slice(0, 16)}`;
  if (path.basename(manifest.holdingPath ?? '') !== name ||
      path.dirname(manifest.holdingPath) !== holdingRoot) {
    return held('move_intent_conflict');
  }
  const source = path.join(importRoot, name);
  const destination = path.join(holdingRoot, `recovered-${name}`);
  let roots, sourceStat, destStat;
  try {
    roots = await Promise.all([importRoot, holdingRoot].map((root) =>
      realpath(root)));
    if (roots[0] === roots[1] ||
        roots[0].startsWith(`${roots[1]}${path.sep}`) ||
        roots[1].startsWith(`${roots[0]}${path.sep}`)) {
      return held('unsafe_move_roots');
    }
    const [importStat, holdingStat] = await Promise.all(
      [importRoot, holdingRoot].map((root) => lstat(root, { bigint: true })));
    if (importStat.isSymbolicLink() || holdingStat.isSymbolicLink() ||
        !importStat.isDirectory() || !holdingStat.isDirectory() ||
        importStat.dev !== holdingStat.dev) return held('unsafe_move_roots');
    [sourceStat, destStat] = await Promise.all([status(source),
      status(destination)]);
  } catch (error) { return heldAfter(error, 'unsafe_move_roots'); }
  if (manifest.files.some(file => file.scope === 'bonus')) {
    return preserveRequestedFiles({manifest,source,destination,fileId,recheck,renameFile:renameTree});
  }
  if (sourceStat && destStat) return held('duplicate_recovery_tree');
  if (destStat) {
    return destStat.isDirectory() && !destStat.isSymbolicLink() &&
      await inspectPureMoveTree(destination, manifest.files) ?
      { state: 'preserved', destination } : held('recovery_tree_changed');
  }
  if (!sourceStat || !sourceStat.isDirectory() || sourceStat.isSymbolicLink() ||
      !await inspectPureMoveTree(source, manifest.files)) {
    return held('published_tree_changed');
  }
  let observed;
  try { observed = await recheck(); }
  catch (error) { return heldAfter(error, 'shoko_unavailable'); }
  if (observed?.state !== 'unrecognized_confirmed' ||
      (validId(fileId) && observed.fileId !== fileId)) {
    return held('recognition_state_changed');
  }
  try {
    await renameTree(source, destination);
    await syncDirectory(importRoot);
    await syncDirectory(holdingRoot);
    return { state: 'preserved', destination };
  } catch (error) {
    return held(error?.code === 'EXDEV' ? 'cross_filesystem_move' :
      'preservation_outcome_unknown');
  }
}
