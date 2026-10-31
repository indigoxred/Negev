import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { torrentFileKind } from '../acquisition/evaluate-stopped-manifest.mjs';
import { makeBytePacer } from './read-pacer.mjs';

const held = (reason) => ({ state: 'held', reason });

export async function verifyStagedSubtitle({
  root, relativePath, maxFileBytes = 16 * 1024 ** 2,
  readPacer, readRateBytesPerSecond = 16 * 1024 ** 2,
}) {
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 ||
      maxFileBytes > 64 * 1024 ** 2 ||
      (readPacer !== undefined && typeof readPacer?.afterBytes !== 'function')) {
    throw new TypeError('Invalid subtitle verification configuration');
  }
  if (typeof root !== 'string' || !path.isAbsolute(root) ||
      torrentFileKind(relativePath) !== 'subtitle') return held('path_outside_staging');
  const pacer = readPacer ?? makeBytePacer({ bytesPerSecond: readRateBytesPerSecond });
  const parts = relativePath.split('/');
  const rootPath = path.resolve(root);
  const fullPath = path.resolve(rootPath, ...parts);
  let before;
  try {
    const rootStat = await lstat(rootPath);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return held('unsafe_source');
    let cursor = rootPath;
    for (const [index, part] of parts.entries()) {
      cursor = path.join(cursor, part);
      const stat = await lstat(cursor, { bigint: true });
      if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory()) ||
          (index === parts.length - 1 && !stat.isFile())) return held('unsafe_source');
      if (index === parts.length - 1) before = stat;
    }
    const [realRoot, realFile] = await Promise.all([realpath(rootPath), realpath(fullPath)]);
    const relative = path.relative(realRoot, realFile);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)) return held('path_outside_staging');
    if (before.size > BigInt(maxFileBytes)) return held('file_over_budget');
  } catch { return held('file_unavailable'); }

  let file;
  try {
    file = await open(fullPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await file.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.size !== before.size || opened.mtimeNs !== before.mtimeNs) {
      return held('file_changed_or_unavailable');
    }
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let remaining = Number(opened.size);
    while (remaining > 0) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, remaining));
      if (bytesRead < 1) return held('file_changed_or_unavailable');
      hash.update(buffer.subarray(0, bytesRead));
      remaining -= bytesRead;
      await pacer.afterBytes(bytesRead);
    }
    const after = await file.stat({ bigint: true });
    if (after.dev !== opened.dev || after.ino !== opened.ino ||
        after.size !== opened.size || after.mtimeNs !== opened.mtimeNs) {
      return held('file_changed_or_unavailable');
    }
    return { state: 'subtitle_verified', sha256: hash.digest('hex').toUpperCase(),
      size: Number(opened.size) };
  } catch { return held('file_changed_or_unavailable'); }
  finally { if (file) await file.close(); }
}
