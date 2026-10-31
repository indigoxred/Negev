import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const held = (reason) => ({ state: 'held', reason });
const inside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative));
};
const validAbsolute = (value) => typeof value === 'string' && value.length > 0 &&
  path.isAbsolute(value) && path.normalize(value) === value &&
  !/[\0\r\n]/.test(value);
const identity = (value) => `${value.dev}:${value.ino}:${value.size}`;
const unchanged = (before, after) => identity(before) === identity(after) &&
  before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;

// Discovery hint only. Neither a matching key nor a successful metadata
// probe is playback proof: the selected Plex card must still be freshly read
// and passed through provePhysicalPlexPart before declaring Available.
export async function probePhysicalCandidate({ filePath, allowedRoot,
  backingRoots = [], expectedSize } = {}) {
  if (!Array.isArray(backingRoots) || backingRoots.length > 8 ||
      ![filePath, allowedRoot, ...backingRoots].every(validAbsolute) ||
      !inside(allowedRoot, filePath) ||
      !Number.isSafeInteger(expectedSize) || expectedSize <= 0) {
    throw new TypeError('Invalid scoped candidate probe');
  }
  let roots, fileReal;
  try {
    [roots, fileReal] = await Promise.all([
      Promise.all([allowedRoot, ...backingRoots].map((root) => realpath(root))),
      realpath(filePath),
    ]);
  } catch { return held('file_unavailable'); }
  if (!roots.some((root) => inside(root, fileReal))) {
    return held('path_outside_roots');
  }
  try {
    const before = await stat(filePath, { bigint: true });
    if (!before.isFile() || before.dev < 0n || before.ino <= 0n) {
      return held('file_unavailable');
    }
    if (before.size !== BigInt(expectedSize)) return held('size_mismatch');
    const [after, fileRealAfter] = await Promise.all([
      stat(filePath, { bigint: true }), realpath(filePath),
    ]);
    if (!unchanged(before, after) || fileRealAfter !== fileReal) {
      return held('file_changed');
    }
    return { state: 'candidate', candidateKey: identity(before) };
  } catch { return held('file_unavailable'); }
}

// All paths are Negev-container paths supplied by explicit read-only mount
// mappings. This performs scoped metadata reads and opens one byte through the
// Plex path. It never hashes or scans a library.
export async function provePhysicalPlexPart({ shokoPath, plexPath, shokoRoot,
  plexRoot, expectedSize } = {}) {
  if (![shokoPath, plexPath, shokoRoot, plexRoot].every(validAbsolute) ||
      !inside(shokoRoot, shokoPath) || !inside(plexRoot, plexPath)) {
    throw new TypeError('Invalid scoped path');
  }
  if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0) {
    throw new TypeError('Invalid expected size');
  }
  let sourceRoot, partRoot, sourceReal, partReal;
  try {
    [sourceRoot, partRoot, sourceReal, partReal] = await Promise.all([
      realpath(shokoRoot), realpath(plexRoot), realpath(shokoPath), realpath(plexPath),
    ]);
  } catch { return held('file_unavailable'); }
  if (!inside(sourceRoot, sourceReal) ||
      !(inside(partRoot, partReal) || inside(sourceRoot, partReal))) {
    return held('path_outside_roots');
  }
  let handle;
  try {
    handle = await open(plexPath, 'r');
    const [sourceBefore, partBefore, pathBefore] = await Promise.all([
      stat(shokoPath, { bigint: true }), handle.stat({ bigint: true }),
      stat(plexPath, { bigint: true }),
    ]);
    if (![sourceBefore, partBefore, pathBefore].every((entry) => entry.isFile())) {
      return held('file_unavailable');
    }
    if ([sourceBefore, partBefore, pathBefore].some((entry) => entry.size !== BigInt(expectedSize))) {
      return held('size_mismatch');
    }
    if (identity(sourceBefore) !== identity(partBefore) ||
        identity(partBefore) !== identity(pathBefore)) return held('different_file');
    const buffer = Buffer.alloc(1);
    if ((await handle.read(buffer, 0, 1, 0)).bytesRead !== 1) return held('file_unavailable');
    const [sourceAfter, partAfter, pathAfter, partRealAfter] = await Promise.all([
      stat(shokoPath, { bigint: true }), handle.stat({ bigint: true }),
      stat(plexPath, { bigint: true }), realpath(plexPath),
    ]);
    if (!unchanged(sourceBefore, sourceAfter) || !unchanged(partBefore, partAfter) ||
        !unchanged(pathBefore, pathAfter) || partRealAfter !== partReal) {
      return held('file_changed');
    }
    return { state: 'same_file', storageKey: identity(sourceBefore) };
  } catch { return held('file_unavailable'); }
  finally { await handle?.close(); }
}
