import { constants } from 'node:fs';
import { chmod, lstat, open, readdir, realpath, rename } from 'node:fs/promises';
import path from 'node:path';

const held = (reason) => ({ state: 'held', reason });

function within(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative));
}

async function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  const handle = await open(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try { await handle.sync(); }
  finally { await handle.close(); }
}

async function inspectTree(root, files) {
  const expected = new Map(files.map((file) => [file.name, file]));
  const expectedDirs = new Set();
  for (const name of expected.keys()) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) expectedDirs.add(parts.slice(0, i).join('/'));
  }
  const found = new Set();
  const seenDirs = new Set();
  async function walk(directory, prefix, depth) {
    if (depth > 32 || found.size > 100 || seenDirs.size > 200) return false;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      const target = path.join(directory, entry.name);
      const stat = await lstat(target, { bigint: true });
      if (stat.isSymbolicLink()) return false;
      if (stat.isDirectory()) {
        if (!expectedDirs.has(name)) return false;
        seenDirs.add(name);
        if (!await walk(target, name, depth + 1)) return false;
      } else if (stat.isFile()) {
        const file = expected.get(name);
        if (!file || found.has(name) || stat.size !== BigInt(file.size) ||
            String(stat.dev) !== file.dev || String(stat.ino) !== file.ino ||
            String(stat.mtimeNs) !== file.mtimeNs) return false;
        found.add(name);
      } else return false;
    }
    return true;
  }
  try {
    return await walk(root, '', 0) && found.size === expected.size &&
      seenDirs.size === expectedDirs.size;
  } catch { return false; }
}

async function pathStatus(target) {
  try { return await lstat(target, { bigint: true }); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

// The journal is already prepared and all selected files live in private
// holding. A whole-directory rename is the only watched-folder mutation.
// If a crash follows rename, the exact destination tree resolves the outcome.
export async function publishPureMove({ attemptId, ledger, holdingRoot,
  importRoot, nowMs, renamePrepared = rename } = {}) {
  if (!Number.isSafeInteger(attemptId) || attemptId < 1 ||
      !Number.isSafeInteger(nowMs) || nowMs < 0 ||
      typeof ledger?.getIntent !== 'function' ||
      typeof ledger?.beginPublish !== 'function' ||
      typeof ledger?.markPublished !== 'function' ||
      typeof holdingRoot !== 'string' || !path.isAbsolute(holdingRoot) ||
      typeof importRoot !== 'string' || !path.isAbsolute(importRoot) ||
      typeof renamePrepared !== 'function') {
    throw new TypeError('Invalid pure publish configuration');
  }
  const row = ledger.getIntent(attemptId);
  if (!row || !['prepared', 'publish_unknown', 'published_observed'].includes(row.status)) {
    return held('move_not_prepared');
  }
  if (row.status === 'published_observed') return { state: 'published_observed' };
  const manifest = row.manifest;
  if (manifest?.attemptId !== attemptId || !Array.isArray(manifest.files) ||
      manifest.files.length < 1) return held('manifest_changed');
  let roots;
  try {
    const stats = await Promise.all([holdingRoot, importRoot].map((root) =>
      lstat(root, { bigint: true })));
    if (stats.some((stat) => !stat.isDirectory() || stat.isSymbolicLink()) ||
        stats[0].dev !== stats[1].dev) return held('unsafe_move_roots');
    roots = await Promise.all([holdingRoot, importRoot].map((root) => realpath(root)));
    if (within(roots[0], roots[1]) || within(roots[1], roots[0]) ||
        path.dirname(manifest.holdingPath) !== roots[0] ||
        path.basename(manifest.holdingPath) !==
          `negev-${attemptId}-${manifest.torrentHash.slice(0, 16)}`) {
      return held('unsafe_move_roots');
    }
  } catch { return held('unsafe_move_roots'); }
  const destination = path.join(roots[1], path.basename(manifest.holdingPath));
  let from, to;
  try {
    [from, to] = await Promise.all([pathStatus(manifest.holdingPath),
      pathStatus(destination)]);
  } catch { return held('publish_outcome_unknown'); }
  if (to && from) return held('destination_exists');
  if (to && row.status === 'publish_unknown') {
    if (!to.isDirectory() || to.isSymbolicLink() ||
        !await inspectTree(destination, manifest.files)) return held('publish_outcome_unknown');
    return ledger.markPublished({ attemptId, nowMs });
  }
  if (!from || to || !from.isDirectory() || from.isSymbolicLink() ||
      from.dev !== (await lstat(roots[0], { bigint: true })).dev ||
      !await inspectTree(manifest.holdingPath, manifest.files)) {
    return held('manifest_changed');
  }
  const begin = ledger.beginPublish({ attemptId, nowMs });
  if (begin?.state !== 'publish_unknown') return held('publish_outcome_unknown');
  try {
    // The holding parent is private. Each nested directory must be traversable
    // by Shoko after publication, including releases with subdirectories.
    const directories = new Set();
    for (const file of manifest.files) {
      const parts = file.name.split('/');
      for (let i = 1; i < parts.length; i++) {
        directories.add(path.join(manifest.holdingPath, ...parts.slice(0, i)));
      }
    }
    for (const directory of directories) await chmod(directory, 0o755);
    await chmod(manifest.holdingPath, 0o755);
    await renamePrepared(manifest.holdingPath, destination);
    await syncDirectory(roots[0]);
    await syncDirectory(roots[1]);
  } catch (error) {
    return held(error?.code === 'EXDEV' ? 'cross_filesystem_move' : 'publish_outcome_unknown');
  }
  try { return ledger.markPublished({ attemptId, nowMs }); }
  catch { return held('publish_outcome_unknown'); }
}
