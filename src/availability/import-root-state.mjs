import path from 'node:path';
import { lstat, opendir } from 'node:fs/promises';

// Bounded view of Shoko's watched Import root. An empty result means only
// that no file was seen during this walk. It is not a settled-import fence:
// the watcher, hash queue and exact target observers must also be checked.
export async function readImportRootState({ root, maxEntries = 256,
  maxDepth = 4 } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root) ||
      path.normalize(root) !== root || /[\0\r\n]/.test(root) ||
      !Number.isSafeInteger(maxEntries) || maxEntries < 1 ||
      maxEntries > 1_000 || !Number.isSafeInteger(maxDepth) ||
      maxDepth < 1 || maxDepth > 8) {
    throw new TypeError('Invalid Import root observation');
  }
  try {
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return { state: 'unavailable' };
    const pending = [{ dir: root, depth: 0 }];
    let visited = 0;
    while (pending.length) {
      const { dir, depth } = pending.pop();
      for await (const entry of await opendir(dir)) {
        visited++;
        if (visited > maxEntries) return { state: 'unavailable' };
        if (entry.isFile()) return { state: 'busy' };
        if (!entry.isDirectory() || depth >= maxDepth) {
          return { state: 'unavailable' };
        }
        pending.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
      }
    }
    return { state: 'empty_observed' };
  } catch { return { state: 'unavailable' }; }
}
