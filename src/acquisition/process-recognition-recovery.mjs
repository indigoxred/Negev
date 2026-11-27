import path from 'node:path';
import { validMount } from '../availability/known-card-availability.mjs';
import { observeShokoUnrecognized } from './observe-shoko-unrecognized.mjs';
import { preserveUnrecognizedTree } from './preserve-unrecognized-tree.mjs';

import { heldReporter } from '../runtime/held-diagnostics.mjs';
const held = (reason) => ({ state: 'held', reason });
const heldAfter = heldReporter('acquisition/process-recognition-recovery');
const validId = (value) => Number.isSafeInteger(value) && value > 0;

export async function processRecognitionRecovery({ attemptId, recovery,
  pureMoves,
  importRoot, holdingRoot, shokoMount, shokoSourcePath = null, readQueue, readFile,
  readUnrecognized, checkTorrent,
  nowMs, preserve = preserveUnrecognizedTree } = {}) {
  if (!validId(attemptId) ||
      typeof recovery?.getEligible !== 'function' ||
      typeof recovery?.get !== 'function' ||
      typeof recovery?.recordFirstSeen !== 'function' ||
      typeof recovery?.beginPreserve !== 'function' ||
      typeof recovery?.markPreserved !== 'function' ||
      typeof recovery?.releaseForAlternate !== 'function' ||
      typeof pureMoves?.getIntent !== 'function' ||
      typeof importRoot !== 'string' || !path.isAbsolute(importRoot) ||
      typeof holdingRoot !== 'string' || !path.isAbsolute(holdingRoot) ||
      !validMount(shokoMount) || (shokoSourcePath !== null && (typeof shokoSourcePath !== 'string' ||
        !path.posix.isAbsolute(shokoSourcePath) || path.posix.normalize(shokoSourcePath) !== shokoSourcePath ||
        /[\\\0\r\n]/.test(shokoSourcePath) ||
        path.posix.relative(shokoMount.appRoot, shokoSourcePath).startsWith('..'))) ||
      typeof readQueue !== 'function' ||
      typeof readFile !== 'function' ||
      typeof readUnrecognized !== 'function' ||
      typeof checkTorrent !== 'function' ||
      typeof preserve !== 'function' || !Number.isSafeInteger(nowMs) ||
      nowMs < 0) throw new TypeError('Invalid recognition recovery');
  const eligible = recovery.getEligible(attemptId);
  if (!eligible) return held('recovery_ineligible');
  const { manifest, video, publishedMs, requestId } = eligible;
  const savedMove = pureMoves.getIntent(attemptId);
  if (savedMove?.status !== 'published_observed' ||
      JSON.stringify(savedMove.manifest) !== JSON.stringify(manifest)) {
    return held('move_intent_conflict');
  }
  const name = `negev-${attemptId}-${manifest.torrentHash.slice(0, 16)}`;
  const local = path.join(importRoot, name, ...video.name.split('/'));
  const relative = path.relative(shokoMount.localRoot, local);
  const childRelative = path.relative(path.join(importRoot,name),local);
  if (!childRelative || childRelative === '..' || childRelative.startsWith(`..${path.sep}`) || path.isAbsolute(childRelative)) return held('published_file_outside_tree');
  if (shokoSourcePath === null && (!relative || relative === '..' ||
      relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))) {
    return held('shoko_source_outside_mount');
  }
  const sourcePath = shokoSourcePath === null ? path.posix.join(shokoMount.appRoot,
    ...relative.split(path.sep)) : path.posix.join(shokoSourcePath,
      path.basename(importRoot),name,...childRelative.split(path.sep));
  const prior = recovery.get(attemptId);
  const observe = () => observeShokoUnrecognized({ sourcePath,
    expectedSize: video.size, publishedMs, nowMs,
    prior: prior && { fileId: prior.fileId,
      firstSeenMs: prior.firstSeenMs },
    readFile, readUnrecognized, readQueue: async () => {
      const result = await readQueue();
      return result?.state === 'queue_idle_unverified'
        ? { state: 'quiet_observed' } : result;
    } });
  if (!['preserve_unknown', 'preserved'].includes(prior?.status)) {
    const observed = await observe();
    if (observed.state === 'unrecognized_pending') {
      if (!prior) recovery.recordFirstSeen({ attemptId,
        fileId: observed.fileId, nowMs });
      return { state: 'awaiting_shoko' };
    }
    if (observed.state !== 'unrecognized_confirmed') {
      return observed.state === 'shoko_unavailable'
        ? held('shoko_unavailable') : observed.state === 'recognized'
          ? { state: 'recognized' } : { state: 'awaiting_shoko' };
    }
  }
  let torrent;
  try { torrent = await checkTorrent({ hash: manifest.torrentHash }); }
  catch (error) { return heldAfter(error, 'torrent_state_unavailable'); }
  if (torrent?.state !== 'stopped') return held('torrent_not_stopped');
  if (prior?.status !== 'preserved') {
    const begin = recovery.beginPreserve({ attemptId,
      fileId: prior?.fileId, nowMs });
    if (begin?.state !== 'preserve_unknown') return begin;
  }
  const saved = await preserve({ manifest, importRoot, holdingRoot,
    fileId: prior?.fileId, recheck: observe });
  if (saved?.state !== 'preserved') return saved ?? held('preservation_unavailable');
  const marked = recovery.markPreserved({ attemptId, nowMs });
  if (marked?.state !== 'preserved') return marked;
  const released = recovery.releaseForAlternate({ attemptId, nowMs });
  return released?.state === 'released'
    ? { state: 'recovered', requestId, attemptId } : released;
}
