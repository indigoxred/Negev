import { createHash } from 'node:crypto';
import path from 'node:path';
import { lstat, opendir } from 'node:fs/promises';

const unavailable = () => ({ state: 'unavailable' });

// Metadata-only, bounded inventory of Shoko's watched Import directory.
// The fingerprint detects changes during a quiet observation; it does not
// establish that Shoko has finished hashing a file or that its bytes match.
export async function readImportRootInventory({ root, maxEntries = 256,
  maxDepth = 4 } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root) ||
      path.normalize(root) !== root || /[\0\r\n]/.test(root) ||
      !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 1_000 ||
      !Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 8) {
    throw new TypeError('Invalid Import inventory configuration');
  }
  try {
    const rootStat = await lstat(root, { bigint: true });
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return unavailable();
    const pending = [{ dir: root, depth: 0 }];
    const files = [];
    const fingerprintParts = [[ '.', 'directory', rootStat.dev, rootStat.ino,
      rootStat.ctimeNs, rootStat.mtimeNs].join('\0')];
    let visited = 0;
    while (pending.length) {
      const { dir, depth } = pending.pop();
      for await (const entry of await opendir(dir)) {
        if (++visited > maxEntries) return unavailable();
        const absolute = path.join(dir, entry.name);
        const relativePath = path.relative(root, absolute).split(path.sep).join('/');
        if (!relativePath || relativePath.length > 4_096 ||
            relativePath.startsWith('../') || relativePath.includes('\0')) return unavailable();
        const stat = await lstat(absolute, { bigint: true });
        if (stat.isSymbolicLink()) return unavailable();
        if (stat.isDirectory()) {
          if (depth >= maxDepth) return unavailable();
          pending.push({ dir: absolute, depth: depth + 1 });
          fingerprintParts.push([relativePath, 'directory', stat.dev, stat.ino,
            stat.ctimeNs, stat.mtimeNs].join('\0'));
        } else if (stat.isFile() && stat.size >= 0n &&
                   stat.size <= BigInt(Number.MAX_SAFE_INTEGER)) {
          files.push({ relativePath, size: Number(stat.size) });
          fingerprintParts.push([relativePath, 'file', stat.dev, stat.ino,
            stat.size, stat.ctimeNs, stat.mtimeNs].join('\0'));
        } else return unavailable();
      }
    }
    files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    const fingerprint = createHash('sha256').update(
      fingerprintParts.sort().join('\n')).digest('hex');
    return { state: 'inventory', files, fingerprint };
  } catch { return unavailable(); }
}
