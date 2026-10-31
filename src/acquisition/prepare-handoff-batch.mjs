import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { ed2kFile } from '../identity/ed2k.mjs';
import { verifyStagedSubtitle } from '../identity/verify-staged-subtitle.mjs';
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
      !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(verified?.torrentHash) ||
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
  if (verified.subtitles.length > 50) return false;
  let subtitleBytes = 0;
  const indexes = new Set();
  for (const file of verified.subtitles) {
    if (torrentFileKind(file?.name) !== 'subtitle' ||
        names.has(file.name.toLowerCase()) ||
        !Number.isSafeInteger(file.index) || file.index < 0 || indexes.has(file.index) ||
        !Number.isSafeInteger(file.size) || file.size < 1 || file.size > 16 * 1024 ** 2 ||
        !/^[0-9A-F]{64}$/.test(file.sha256)) return false;
    names.add(file.name.toLowerCase());
    indexes.add(file.index);
    subtitleBytes += file.size;
    if (subtitleBytes > 64 * 1024 ** 2) return false;
  }
  return true;
}

function evidenceDigest(verified) {
  const byName = (a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  const videos = verified.files.map((file) => ({ name: file.name, size: file.size,
    ed2k: file.ed2k, anidbFileId: file.anidbFileId,
    episodeIds: [...file.episodeIds].sort((a, b) => a - b) })).sort(byName);
  const subtitles = verified.subtitles.map((file) => ({ name: file.name, size: file.size,
    sha256: file.sha256 })).sort(byName);
  return createHash('sha256').update(JSON.stringify({ version: 1,
    torrentHash: verified.torrentHash.toLowerCase(), videos, subtitles }))
    .digest('hex');
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

async function copyVerifiedFile({ stagingRoot, holdingPath, file, kind, pacer }) {
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
  const copiedHash = kind === 'subtitle'
    ? await verifyStagedSubtitle({ root: holdingPath, relativePath: file.name, readPacer: pacer })
    : await ed2kFile(destinationPath, { pacer });
  if (copiedHash.size !== file.size ||
      (kind === 'subtitle' ? copiedHash.sha256 !== file.sha256 : copiedHash.ed2k !== file.ed2k)) {
    throw new Error('source_changed');
  }
}

// Copies exact AniDB-verified videos and bounded hashed subtitles to private holding.
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
  const roots = await inspectRoots(stagingRoot, holdingRoot, importRoot);
  if (!roots) return held('unsafe_handoff_roots');
  const pacer = readPacer ?? makeBytePacer({ bytesPerSecond: readRateBytesPerSecond });
  let holdingPath;
  try {
    holdingPath = await mkdtemp(path.join(holdingRoot, '.negev-prep-'));
    for (const file of verified.files) {
      await copyVerifiedFile({ stagingRoot: roots[0], holdingPath, file, kind: 'video', pacer });
    }
    for (const file of verified.subtitles) {
      await copyVerifiedFile({ stagingRoot: roots[0], holdingPath, file, kind: 'subtitle', pacer });
    }
    return { state: 'handoff_prepared', holdingPath,
      torrentHash: verified.torrentHash.toLowerCase(), evidenceDigest: evidenceDigest(verified),
      files: verified.files.map((file) => ({ ...file, episodeIds: [...file.episodeIds] })),
      subtitles: verified.subtitles.map((file) => ({ ...file })),
      publishReady: false };
  } catch (error) {
    if (holdingPath) await rm(holdingPath, { recursive: true, force: true });
    return held(error?.message === 'source_changed' ? 'source_changed' : 'copy_or_source_unavailable');
  }
}
