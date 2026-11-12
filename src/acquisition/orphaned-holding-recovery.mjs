import { DatabaseSync } from 'node:sqlite';
import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';

// Only Negev's private, unfinished copy directories are eligible. A prepared
// handoff is journaled before publication and must never be swept here.
export async function recoverOrphanedHolding({ holdingRoot, dbPath } = {}) {
  if (typeof holdingRoot !== 'string' || !path.isAbsolute(holdingRoot) ||
      path.basename(holdingRoot) !== 'holding' ||
      typeof dbPath !== 'string' || !path.isAbsolute(dbPath)) {
    throw new TypeError('Private holding recovery requires absolute paths');
  }
  let rootStat;
  try { rootStat = await lstat(holdingRoot); }
  catch (error) {
    if (error?.code === 'ENOENT') return { removed: 0 };
    throw error;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() ||
      await realpath(holdingRoot) !== holdingRoot) {
    throw new Error('Unsafe private holding root');
  }
  const entries = (await readdir(holdingRoot, { withFileTypes: true }))
    .filter((entry) => /^\.negev-prep-[A-Za-z0-9]{6}$/.test(entry.name));
  if (entries.length > 128) throw new Error('Too many private preparations');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let removed = 0;
  try {
    const recorded = db.prepare(`SELECT 1 FROM handoff_intents
      WHERE holding_path=? LIMIT 1`);
    for (const entry of entries) {
      if (!entry.isDirectory()) throw new Error('Unsafe private preparation');
      const folder = path.join(holdingRoot, entry.name);
      const stat = await lstat(folder);
      if (!stat.isDirectory() || stat.isSymbolicLink() ||
          await realpath(folder) !== folder) {
        throw new Error('Unsafe private preparation');
      }
      if (recorded.get(folder)) continue;
      await rm(folder, { recursive: true, force: false });
      removed++;
    }
  } finally { db.close(); }
  return { removed };
}
