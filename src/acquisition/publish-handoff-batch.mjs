import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, rename } from 'node:fs/promises';
import path from 'node:path';
import { verifyStagedFile } from '../identity/verify-staged-file.mjs';
import { verifyStagedSubtitle } from '../identity/verify-staged-subtitle.mjs';
import { makeBytePacer } from '../identity/read-pacer.mjs';
import { evaluateHandoffEvidence } from './handoff-evidence.mjs';

const held = (reason) => ({ state: 'held', reason });
const admitted = (result, file) => result?.isCorrupted === false &&
  Array.isArray(result.coverage) && result.coverage.length === file.episodeIds.length &&
  file.episodeIds.every((episodeId) => result.coverage.some((range) =>
    range.episodeId === episodeId && range.start === 0 && range.end === 100));

function within(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative));
}

async function exactTree(root, manifest) {
  const expectedFiles = new Set([...manifest.videos, ...manifest.subtitles]
    .map((file) => file.name));
  const expectedDirs = new Set();
  for (const name of expectedFiles) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) expectedDirs.add(parts.slice(0, i).join('/'));
  }
  const files = new Set();
  const dirs = new Set();
  async function walk(directory, prefix, depth) {
    if (depth > 32 || files.size > 100 || dirs.size > 200) throw Error('tree_limit');
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      const fullPath = path.join(directory, entry.name);
      const stat = await lstat(fullPath);
      if (stat.isSymbolicLink()) throw Error('symlink');
      if (stat.isDirectory()) {
        if (!expectedDirs.has(name)) throw Error('unexpected_directory');
        dirs.add(name);
        await walk(fullPath, name, depth + 1);
      } else if (stat.isFile()) {
        if (!expectedFiles.has(name)) throw Error('unexpected_file');
        files.add(name);
      } else throw Error('special_file');
    }
  }
  try { await walk(root, '', 0); }
  catch { return null; }
  if (files.size !== expectedFiles.size || dirs.size !== expectedDirs.size) return null;
  return [...dirs].sort((a, b) => b.split('/').length - a.split('/').length);
}

async function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  const handle = await open(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try { await handle.sync(); }
  finally { await handle.close(); }
}

async function destinationAbsent(destination) {
  try { await lstat(destination); return false; }
  catch (error) { return error?.code === 'ENOENT'; }
}

async function reconcileUnknownPublish({ attemptId, row, evidence, holdingRoot,
  importRoot, lookup, ledger, nowMs, readPacer, readRateBytesPerSecond,
  verifyVideo, verifySubtitle }) {
  if (typeof ledger.markPublishedObserved !== 'function' ||
      typeof holdingRoot !== 'string' || !path.isAbsolute(holdingRoot) ||
      typeof importRoot !== 'string' || !path.isAbsolute(importRoot)) {
    return held('unsafe_handoff_roots');
  }
  let destination;
  let before;
  try {
    const [holdingStat, importStat] = await Promise.all([
      lstat(holdingRoot, { bigint: true }), lstat(importRoot, { bigint: true })]);
    if (!holdingStat.isDirectory() || holdingStat.isSymbolicLink() ||
        !importStat.isDirectory() || importStat.isSymbolicLink() ||
        holdingStat.dev !== importStat.dev) return held('unsafe_handoff_roots');
    const [realHolding, realImport] = await Promise.all([
      realpath(holdingRoot), realpath(importRoot)]);
    if (within(realHolding, realImport) || within(realImport, realHolding) ||
        path.dirname(row.holdingPath) !== realHolding ||
        !path.basename(row.holdingPath).startsWith('.negev-prep-') ||
        row.publishName !== `negev-${attemptId}-${evidence.digest.slice(0, 16)}` ||
        !await destinationAbsent(row.holdingPath)) return held('publish_outcome_unknown');
    destination = path.join(realImport, row.publishName);
    before = await lstat(destination, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink() ||
        before.dev !== importStat.dev ||
        path.dirname(await realpath(destination)) !== realImport) {
      return held('publish_outcome_unknown');
    }
  } catch { return held('publish_outcome_unknown'); }
  if (!await exactTree(destination, evidence.manifest)) return held('publish_outcome_unknown');
  const pacer = readPacer ?? makeBytePacer({ bytesPerSecond: readRateBytesPerSecond });
  for (const file of evidence.manifest.videos) {
    let result;
    try { result = await verifyVideo({ root: destination, relativePath: file.name,
      expected: { animeId: evidence.manifest.anidbId, episodeIds: file.episodeIds },
      lookup, readPacer: pacer }); }
    catch { return held('publish_outcome_unknown'); }
    if (result?.state !== 'identity_verified' || result.fileId !== file.anidbFileId ||
        result.ed2k !== file.ed2k || result.size !== file.size || !admitted(result, file)) {
      return held('publish_outcome_unknown');
    }
  }
  for (const file of evidence.manifest.subtitles) {
    let result;
    try { result = await verifySubtitle({ root: destination,
      relativePath: file.name, readPacer: pacer }); }
    catch { return held('publish_outcome_unknown'); }
    if (result?.state !== 'subtitle_verified' || result.sha256 !== file.sha256 ||
        result.size !== file.size) return held('publish_outcome_unknown');
  }
  try {
    const after = await lstat(destination, { bigint: true });
    if (!await exactTree(destination, evidence.manifest) ||
        !await destinationAbsent(row.holdingPath) ||
        after.dev !== before.dev || after.ino !== before.ino ||
        after.mtimeNs !== before.mtimeNs ||
        path.dirname(await realpath(destination)) !== path.dirname(destination)) {
      return held('publish_outcome_unknown');
    }
  } catch { return held('publish_outcome_unknown'); }
  let result;
  try { result = ledger.markPublishedObserved({ attemptId,
    evidenceDigest: evidence.digest, publishName: row.publishName, nowMs }); }
  catch { return held('publish_outcome_unknown'); }
  return result?.state === 'published_observed'
    ? { state: 'published_observed', destination }
    : held('publish_outcome_unknown');
}

// Local building block only. A caller must supply current NAS mount proof and
// a private prepared batch. This never marks Shoko import or Plex availability.
export async function publishPreparedHandoff({
  attemptId, prepared, ledger, holdingRoot, importRoot, lookup, nowMs,
  readPacer, readRateBytesPerSecond = 16 * 1024 ** 2,
  verifyVideo = verifyStagedFile, verifySubtitle = verifyStagedSubtitle,
}) {
  if (!Number.isSafeInteger(attemptId) || attemptId < 1 ||
      !Number.isSafeInteger(nowMs) || nowMs < 0 ||
      typeof ledger?.getHandoff !== 'function' ||
      typeof ledger?.beginPublish !== 'function' ||
      typeof lookup !== 'function' || typeof verifyVideo !== 'function' ||
      typeof verifySubtitle !== 'function' ||
      (readPacer !== undefined && typeof readPacer?.afterBytes !== 'function')) {
    throw new TypeError('Invalid handoff publish configuration');
  }
  if (prepared?.state !== 'handoff_prepared' || prepared.publishReady !== false) {
    return held('invalid_prepared_batch');
  }
  const evidence = evaluateHandoffEvidence(prepared);
  if (evidence.state !== 'valid' || evidence.digest !== prepared.evidenceDigest) {
    return held('handoff_evidence_mismatch');
  }
  const row = ledger.getHandoff(attemptId);
  if (!row) return held('handoff_missing');
  if (row.evidenceDigest !== evidence.digest ||
      row.torrentHash !== evidence.manifest.torrentHash ||
      row.holdingPath !== prepared.holdingPath ||
      JSON.stringify(row.manifest) !== JSON.stringify(evidence.manifest) ||
      row.publishName !== `negev-${attemptId}-${evidence.digest.slice(0, 16)}`) {
    return held('handoff_conflict');
  }
  if (row.status === 'publish_unknown') return reconcileUnknownPublish({ attemptId,
    row, evidence, holdingRoot, importRoot, lookup, ledger, nowMs, readPacer,
    readRateBytesPerSecond, verifyVideo, verifySubtitle });
  if (row.status === 'published_observed') return { state: 'published_observed' };
  if (row.status !== 'prepared') return held('publish_outcome_unknown');
  if (typeof holdingRoot !== 'string' || !path.isAbsolute(holdingRoot) ||
      typeof importRoot !== 'string' || !path.isAbsolute(importRoot)) {
    return held('unsafe_handoff_roots');
  }
  let holdingPath;
  let destination;
  let before;
  try {
    const [holdingRootStat, importRootStat, holdingStat] = await Promise.all([
      lstat(holdingRoot, { bigint: true }), lstat(importRoot, { bigint: true }),
      lstat(row.holdingPath, { bigint: true }),
    ]);
    if ([holdingRootStat, importRootStat, holdingStat].some((stat) =>
      !stat.isDirectory() || stat.isSymbolicLink()) ||
        holdingRootStat.dev !== importRootStat.dev ||
        holdingStat.dev !== holdingRootStat.dev ||
        (process.platform !== 'win32' && (holdingStat.mode & 0o077n) !== 0n)) {
      return held('unsafe_handoff_roots');
    }
    const [realHoldingRoot, realImportRoot, realHolding] = await Promise.all([
      realpath(holdingRoot), realpath(importRoot), realpath(row.holdingPath),
    ]);
    if (within(realHoldingRoot, realImportRoot) ||
        within(realImportRoot, realHoldingRoot) ||
        path.dirname(realHolding) !== realHoldingRoot ||
        !path.basename(realHolding).startsWith('.negev-prep-')) {
      return held('unsafe_handoff_roots');
    }
    holdingPath = realHolding;
    destination = path.join(realImportRoot, row.publishName);
    before = holdingStat;
  } catch { return held('unsafe_handoff_roots'); }
  if (!await destinationAbsent(destination)) return held('destination_exists');
  const initialDirs = await exactTree(holdingPath, evidence.manifest);
  if (!initialDirs) return held('manifest_tree_mismatch');
  const pacer = readPacer ?? makeBytePacer({ bytesPerSecond: readRateBytesPerSecond });
  for (const file of evidence.manifest.videos) {
    let result;
    try { result = await verifyVideo({ root: holdingPath, relativePath: file.name,
      expected: { animeId: evidence.manifest.anidbId, episodeIds: file.episodeIds },
      lookup, readPacer: pacer }); }
    catch { return held('identity_unavailable'); }
    if (result?.state !== 'identity_verified' || result.fileId !== file.anidbFileId ||
        result.ed2k !== file.ed2k || result.size !== file.size) {
      return held('identity_changed');
    }
    if (!admitted(result, file)) return held('import_admission_failed');
  }
  for (const file of evidence.manifest.subtitles) {
    let result;
    try { result = await verifySubtitle({ root: holdingPath,
      relativePath: file.name, readPacer: pacer }); }
    catch { return held('subtitle_unavailable'); }
    if (result?.state !== 'subtitle_verified' || result.sha256 !== file.sha256 ||
        result.size !== file.size) return held('subtitle_changed');
  }
  const finalDirs = await exactTree(holdingPath, evidence.manifest);
  if (!finalDirs || !await destinationAbsent(destination)) return held('manifest_changed');
  try {
    const after = await lstat(holdingPath, { bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino ||
        after.mtimeNs !== before.mtimeNs) return held('manifest_changed');
    for (const name of finalDirs) await syncDirectory(path.join(holdingPath, ...name.split('/')));
    await syncDirectory(holdingPath);
  } catch { return held('manifest_changed'); }
  const intent = ledger.beginPublish({ attemptId, evidenceDigest: evidence.digest, nowMs });
  if (intent?.state !== 'publish_unknown' || !intent.sendNow ||
      intent.publishName !== row.publishName) return held('publish_outcome_unknown');
  try {
    await rename(holdingPath, destination);
    await syncDirectory(path.dirname(destination));
  } catch { return held('publish_outcome_unknown'); }
  return { state: 'publish_unknown', destination };
}
