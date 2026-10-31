import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { ed2kFile } from './ed2k.mjs';
import { evaluatePreview } from './evaluate-preview.mjs';
import { makeBytePacer } from './read-pacer.mjs';

const held = (reason) => ({ state: 'held', reason });
const VIDEO_EXTENSIONS = new Set(['.mkv', '.mp4', '.m4v', '.avi', '.webm', '.ts']);

// Identity check only. A separate worker must prove qBittorrent completion
// and recheck the file before any later Shoko Import handoff.
export async function verifyStagedFile({
  root, relativePath, expected, lookup, maxFileBytes = 64 * 1024 ** 3,
  readPacer, readRateBytesPerSecond = 16 * 1024 ** 2,
}) {
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > 1024 ** 4) {
    throw new TypeError('Invalid staged file byte budget');
  }
  if (readPacer !== undefined && typeof readPacer?.afterBytes !== 'function') {
    throw new TypeError('Invalid staged file read pacer');
  }
  const pacer = readPacer ?? makeBytePacer({ bytesPerSecond: readRateBytesPerSecond });
  if (typeof root !== 'string' || !path.isAbsolute(root) ||
      typeof relativePath !== 'string' || path.isAbsolute(relativePath) ||
      relativePath.includes('\\') || relativePath.includes('\0')) {
    return held('path_outside_staging');
  }
  const parts = relativePath.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    return held('path_outside_staging');
  }
  if (!VIDEO_EXTENSIONS.has(path.extname(parts.at(-1)).toLowerCase())) {
    return held('unsupported_file_type');
  }

  const fullPath = path.resolve(root, ...parts);
  const inside = path.relative(path.resolve(root), fullPath);
  if (!inside || inside.startsWith(`..${path.sep}`) || inside === '..' || path.isAbsolute(inside)) {
    return held('path_outside_staging');
  }

  let before;
  try {
    const rootStat = await lstat(root);
    if (rootStat.isSymbolicLink()) return held('symlink_in_staging');
    if (!rootStat.isDirectory()) return held('non_regular_file');
    let cursor = root;
    for (const [index, part] of parts.entries()) {
      cursor = path.join(cursor, part);
      const info = await lstat(cursor, { bigint: true });
      if (info.isSymbolicLink()) return held('symlink_in_staging');
      if (index < parts.length - 1 && !info.isDirectory()) return held('non_regular_file');
      if (index === parts.length - 1) {
        if (!info.isFile()) return held('non_regular_file');
        if (info.size > BigInt(maxFileBytes)) return held('file_over_budget');
        before = info;
      }
    }
    const [realRoot, realFile] = await Promise.all([realpath(root), realpath(fullPath)]);
    const realInside = path.relative(realRoot, realFile);
    if (!realInside || realInside === '..' || realInside.startsWith(`..${path.sep}`) || path.isAbsolute(realInside)) {
      return held('path_outside_staging');
    }
  } catch {
    return held('file_unavailable');
  }

  let hash;
  try { hash = await ed2kFile(fullPath, { pacer }); }
  catch { return held('file_changed_or_unavailable'); }

  let preview;
  try { preview = await lookup(hash); }
  catch { return held('provider_unavailable'); }

  try {
    const after = await lstat(fullPath, { bigint: true });
    if (!after.isFile() || after.isSymbolicLink() ||
        after.dev !== before.dev || after.ino !== before.ino ||
        after.size !== before.size || after.mtimeNs !== before.mtimeNs ||
        after.size !== BigInt(hash.size)) return held('file_changed_or_unavailable');
  } catch { return held('file_changed_or_unavailable'); }

  const decision = evaluatePreview(preview, { ...expected, ...hash });
  if (decision.state !== 'accepted') return decision;
  return { state: 'identity_verified', fileId: decision.fileId,
    coverage: decision.coverage, ...hash };
}
