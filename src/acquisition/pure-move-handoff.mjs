import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename } from 'node:fs/promises';
import path from 'node:path';
import { torrentFileKind } from './evaluate-stopped-manifest.mjs';

const held = (reason) => ({ state: 'held', reason });
const HASH = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

function within(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative));
}

function validName(name) {
  return typeof name === 'string' && name.length < 1024 &&
    !name.includes('\\') && !name.includes('\0') && !name.includes(':') &&
    !name.startsWith('/') && name.split('/').every((part) =>
      part && part !== '.' && part !== '..' && part.length <= 255);
}

async function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  const handle = await open(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try { await handle.sync(); }
  finally { await handle.close(); }
}

async function existing(pathname) {
  try { return await lstat(pathname, { bigint: true }); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

async function safeHoldingParents(holdingPath, parts, expectedDev) {
  let cursor = holdingPath;
  for (const part of [null, ...parts.slice(0, -1)]) {
    if (part !== null) cursor = path.join(cursor, part);
    let stat;
    try { stat = await existing(cursor); }
    catch { return false; }
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink() ||
        stat.dev !== expectedDev)) return false;
  }
  return true;
}

// Moves only selected files after the caller durably records the full intent.
// The caller must already have stopped and re-observed the owned qBittorrent
// torrent. A repeated call can finish a move interrupted between files.
export async function preparePureMove({ attemptId, torrentHash, stagingRoot,
  holdingRoot, importRoot, files, recordIntent, renameFile = rename } = {}) {
  if (!Number.isSafeInteger(attemptId) || attemptId < 1 ||
      typeof torrentHash !== 'string' || !HASH.test(torrentHash) ||
      [stagingRoot, holdingRoot, importRoot].some((root) =>
        typeof root !== 'string' || !path.isAbsolute(root)) ||
      typeof recordIntent !== 'function' || typeof renameFile !== 'function') {
    throw new TypeError('Invalid pure move configuration');
  }
  if (!Array.isArray(files) || files.length < 1 || files.length > 100 ||
      files.some((file) => !validName(file?.name) ||
        !['video', 'subtitle'].includes(torrentFileKind(file.name)) ||
        !Number.isSafeInteger(file.size) || file.size < 1 ||
        (torrentFileKind(file.name) === 'video' &&
          (!Array.isArray(file.episodeIds) || file.episodeIds.length < 1 ||
            file.episodeIds.some((id) => !Number.isSafeInteger(id) || id < 1)))) ||
      new Set(files.map((file) => file.name.toLowerCase())).size !== files.length ||
      !files.some((file) => torrentFileKind(file.name) === 'video')) {
    return held('invalid_move_manifest');
  }
  let roots, holdingDev;
  try {
    const input = [stagingRoot, holdingRoot, importRoot];
    const stats = await Promise.all(input.map((root) => lstat(root, { bigint: true })));
    if (stats.some((item) => !item.isDirectory() || item.isSymbolicLink()) ||
        stats.some((item) => item.dev !== stats[0].dev)) return held('unsafe_move_roots');
    holdingDev = stats[1].dev;
    roots = await Promise.all(input.map((root) => realpath(root)));
    if (roots.some((root, i) => roots.some((other, j) => i !== j &&
      (within(root, other) || within(other, root))))) return held('unsafe_move_roots');
  } catch { return held('unsafe_move_roots'); }
  const holdingPath = path.join(roots[1], `negev-${attemptId}-${torrentHash.slice(0, 16).toLowerCase()}`);
  const manifest = [];
  for (const file of files) {
    const parts = file.name.split('/');
    if (!await safeHoldingParents(holdingPath, parts, holdingDev)) {
      return held('unsafe_holding_path');
    }
    let cursor = roots[0];
    try {
      for (const [index, part] of parts.entries()) {
        cursor = path.join(cursor, part);
        if (index < parts.length - 1) {
          const stat = await lstat(cursor, { bigint: true });
          if (!stat.isDirectory() || stat.isSymbolicLink()) return held('unsafe_source');
        }
      }
      const source = await existing(cursor);
      const destination = await existing(path.join(holdingPath, ...parts));
      const found = source ?? destination;
      if (!found || !found.isFile() || found.isSymbolicLink() ||
          found.size !== BigInt(file.size) || (source && destination)) {
        return held('source_changed');
      }
      if (source && !within(roots[0], await realpath(cursor))) return held('unsafe_source');
      manifest.push({ name: file.name, size: file.size,
        ...(torrentFileKind(file.name) === 'video'
          ? { episodeIds: [...file.episodeIds] } : {}),
        dev: String(found.dev), ino: String(found.ino),
        mtimeNs: String(found.mtimeNs) });
    } catch { return held('source_unavailable'); }
  }
  let recorded;
  try { recorded = await recordIntent({ attemptId, torrentHash: torrentHash.toLowerCase(),
    stagingRoot: roots[0], holdingPath, files: manifest }); }
  catch { return held('intent_unavailable'); }
  if (recorded?.state !== 'recorded') return held('intent_unavailable');
  try {
    try { await mkdir(holdingPath, { mode: 0o700 }); }
    catch (error) { if (error?.code !== 'EEXIST') throw error; }
    for (const file of manifest) {
      const parts = file.name.split('/');
      const source = path.join(roots[0], ...parts);
      const destination = path.join(holdingPath, ...parts);
      if (!await safeHoldingParents(holdingPath, parts, holdingDev)) {
        return held('unsafe_holding_path');
      }
      const from = await existing(source);
      const to = await existing(destination);
      const same = (stat) => stat && stat.isFile() && !stat.isSymbolicLink() &&
        String(stat.dev) === file.dev && String(stat.ino) === file.ino &&
        String(stat.mtimeNs) === file.mtimeNs && stat.size === BigInt(file.size);
      if (to && !from && same(to)) continue;
      if (!same(from) || to) return held('source_changed_after_intent');
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      if (!await safeHoldingParents(holdingPath, parts, holdingDev)) {
        return held('unsafe_holding_path');
      }
      await renameFile(source, destination);
      // qBittorrent owns the inode. Preserve its mode rather than trying to
      // chmod it as Negev's different uid after the same-filesystem rename.
      await syncDirectory(path.dirname(source));
      await syncDirectory(path.dirname(destination));
    }
    await syncDirectory(holdingPath);
    return { state: 'prepared', holdingPath, files: manifest };
  } catch (error) {
    return held(error?.code === 'EXDEV' ? 'cross_filesystem_move' : 'move_outcome_unknown');
  }
}
