import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { ed2kFile } from '../identity/ed2k.mjs';
import { makeBytePacer } from '../identity/read-pacer.mjs';
import { torrentFileKind } from './evaluate-stopped-manifest.mjs';

const held = (reason) => ({ state: 'held', reason });
const DEFAULT_BUDGET = 64 * 1024 ** 3;

function within(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative));
}

function validEvidence(verified, budget) {
  if (verified?.state !== 'batch_identity_verified' || verified.handoffReady !== false ||
      !Array.isArray(verified.subtitles) ||
      !Array.isArray(verified.files) || verified.files.length < 1 || verified.files.length > 50) {
    return false;
  }
  const names = new Set();
  const fileIds = new Set();
  let total = 0;
  for (const file of verified.files) {
    if (torrentFileKind(file?.name) !== 'video' || names.has(file.name.toLowerCase()) ||
        !Number.isSafeInteger(file.size) || file.size < 1 ||
        !Number.isSafeInteger(file.anidbFileId) || file.anidbFileId < 1 ||
        !/^[0-9A-F]{32}$/.test(file.ed2k) || fileIds.has(file.anidbFileId) ||
        !Array.isArray(file.episodeIds) || file.episodeIds.length < 1 ||
        file.episodeIds.some((id) => !Number.isSafeInteger(id) || id < 1) ||
        new Set(file.episodeIds).size !== file.episodeIds.length) return false;
    names.add(file.name.toLowerCase());
    fileIds.add(file.anidbFileId);
    total += file.size;
    if (!Number.isSafeInteger(total) || total > budget) return false;
  }
  return true;
}

async function inspectRoots(stagingRoot, holdingRoot, importRoot) {
  const roots = [stagingRoot, holdingRoot, importRoot];
  if (roots.some((root) => typeof root !== 'string' || !path.isAbsolute(root))) return null;
  try {
    const stats = await Promise.all(roots.map((root) => lstat(root, { bigint: true })));
    if (stats.some((stat) => !stat.isDirectory() || stat.isSymbolicLink()) ||
        stats[1].dev !== stats[2].dev) return null;
    const resolved = await Promise.all(roots.map((root) => realpath(root)));
    for (let i = 0; i < resolved.length; i++) {
      for (let j = i + 1; j < resolved.length; j++) {
        if (within(resolved[i], resolved[j]) || within(resolved[j], resolved[i])) return null;
      }
    }
    return resolved;
  } catch { return null; }
}

async function copyVerifiedFile({ stagingRoot, holdingPath, file, pacer }) {
  const parts = file.name.split('/');
  let cursor = stagingRoot;
  for (const [index, part] of parts.entries()) {
    cursor = path.join(cursor, part);
    const stat = await lstat(cursor, { bigint: true });
    if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory()) ||
        (index === parts.length - 1 && !stat.isFile())) throw new Error('unsafe_source');
  }
  const sourcePath = cursor;
  const sourceReal = await realpath(sourcePath);
  if (!within(stagingRoot, sourceReal) || sourceReal === stagingRoot) {
    throw new Error('unsafe_source');
  }
  const destinationPath = path.join(holdingPath, ...parts);
  await mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
  const nofollow = constants.O_NOFOLLOW ?? 0;
  const source = await open(sourcePath, constants.O_RDONLY | nofollow);
  let destination;
  try {
    const before = await source.stat({ bigint: true });
    if (!before.isFile() || before.size !== BigInt(file.size)) throw new Error('source_changed');
    destination = await open(destinationPath, constants.O_WRONLY | constants.O_CREAT |
      constants.O_EXCL | nofollow, 0o600);
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let copied = 0;
    while (copied < file.size) {
      const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, file.size - copied));
      if (bytesRead < 1) throw new Error('source_changed');
      let written = 0;
      while (written < bytesRead) {
        const result = await destination.write(buffer, written, bytesRead - written);
        if (result.bytesWritten < 1) throw new Error('copy_failed');
        written += result.bytesWritten;
      }
      copied += bytesRead;
      await pacer.afterBytes(bytesRead);
    }
    const after = await source.stat({ bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino ||
        after.size !== before.size || after.mtimeNs !== before.mtimeNs) {
      throw new Error('source_changed');
    }
    await destination.sync();
  } finally {
    if (destination) await destination.close();
    await source.close();
  }
  const copiedHash = await ed2kFile(destinationPath, { pacer });
  if (copiedHash.size !== file.size || copiedHash.ed2k !== file.ed2k) {
    throw new Error('source_changed');
  }
}

// Copies only exact AniDB-verified videos to a private, unwatched holding root.
// This never publishes a file into Shoko Import or changes the source torrent.
export async function prepareHandoffBatch({
  stagingRoot, holdingRoot, importRoot, verified,
  maxTotalBytes = DEFAULT_BUDGET, readPacer,
  readRateBytesPerSecond = 16 * 1024 ** 2,
}) {
  if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 1 ||
      maxTotalBytes > 1024 ** 4 ||
      (readPacer !== undefined && typeof readPacer?.afterBytes !== 'function')) {
    throw new TypeError('Invalid handoff preparation configuration');
  }
  if (!validEvidence(verified, maxTotalBytes)) return held('invalid_verified_batch');
  if (verified.subtitles.length > 0) return held('subtitle_handoff_not_ready');
  const roots = await inspectRoots(stagingRoot, holdingRoot, importRoot);
  if (!roots) return held('unsafe_handoff_roots');
  const pacer = readPacer ?? makeBytePacer({ bytesPerSecond: readRateBytesPerSecond });
  let holdingPath;
  try {
    holdingPath = await mkdtemp(path.join(holdingRoot, '.negev-prep-'));
    for (const file of verified.files) {
      await copyVerifiedFile({ stagingRoot: roots[0], holdingPath, file, pacer });
    }
    return { state: 'handoff_prepared', holdingPath,
      files: verified.files.map((file) => ({ ...file, episodeIds: [...file.episodeIds] })),
      publishReady: false };
  } catch (error) {
    if (holdingPath) await rm(holdingPath, { recursive: true, force: true });
    return held(error?.message === 'source_changed' ? 'source_changed' : 'copy_or_source_unavailable');
  }
}
