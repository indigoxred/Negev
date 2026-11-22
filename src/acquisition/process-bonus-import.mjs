import { observePureMoveImport } from './observe-pure-move-import.mjs';
import { torrentFileKind } from './evaluate-stopped-manifest.mjs';

const validId = (value) => Number.isSafeInteger(value) && value > 0;
const pending = new Set(['selected', 'published', 'identified', 'attention']);
const kinds = new Set(['ova', 'movie', 'extra', 'special']);
const sameEpisode = (left, right) => Array.isArray(left) && Array.isArray(right) &&
  left.length === 1 && right.length === 1 && validId(left[0]) && left[0] === right[0];
const sameFile = (left, right) => left?.name === right?.name && left?.size === right?.size &&
  left?.anidbId === right?.anidbId && left?.kind === right?.kind &&
  sameEpisode(left?.episodeIds, right?.episodeIds);

// One independent optional file per call. The observer reads Shoko and probes
// physical identity; it does not import, move, rescan, download or match media.
export async function processBonusImport({ item, acquisitions, pureMoves,
  readEpisode, verifyPublic, shokoMount, probeImpl, now = Date.now } = {}) {
  if (typeof acquisitions?.getAttempt !== 'function' ||
      typeof acquisitions?.getBonusPlan !== 'function' ||
      typeof acquisitions?.recordBonusProgress !== 'function' ||
      typeof acquisitions?.releaseBonusClaimForReview !== 'function' ||
      typeof pureMoves?.getIntent !== 'function' || typeof now !== 'function' ||
      typeof readEpisode !== 'function' || typeof verifyPublic !== 'function') {
    throw new TypeError('Invalid bonus import configuration');
  }
  const waiting = (reason, nextCheckMs) => ({ state: 'bonus_waiting',
    attemptId: item?.attemptId, name: item?.name, reason,
    ...(nextCheckMs === undefined ? {} : { nextCheckMs }) });
  if (!validId(item?.attemptId) || torrentFileKind(item?.name) !== 'video' ||
      !validId(item?.size) || !validId(item?.anidbId) || !kinds.has(item?.kind) ||
      !sameEpisode(item?.episodeIds, item?.episodeIds) || !pending.has(item?.status)) {
    return waiting('invalid_bonus_item');
  }
  let publishedMs = null;
  let claimReleasedMs = item.claimReleasedMs ?? null;
  let currentStatus = item.status;
  let currentFileId = validId(item.fileId) ? item.fileId : undefined;
  const clock = () => {
    const time = now();
    if (!Number.isSafeInteger(time) || time < 0 || time > Number.MAX_SAFE_INTEGER - 3600_000) {
      throw new TypeError('Invalid bonus import clock');
    }
    return time;
  };
  const save = (status, { fileId = currentFileId, reason, delay = false } = {}) => {
    const nowMs = clock();
    const nextCheckMs = nowMs + (delay ? claimReleasedMs === null ? 60_000 : 3600_000 : 0);
    try {
      const result = acquisitions.recordBonusProgress({ attemptId: item.attemptId,
        name: item.name, status, nowMs, nextCheckMs,
        ...(fileId === undefined ? {} : { fileId }), ...(reason ? { reason } : {}) });
      if (result?.state !== status) return false;
      currentStatus = status;
      currentFileId = fileId;
      return true;
    } catch { return false; }
  };
  const retry = (reason) => {
    const nowMs=clock();
    // Optional observation owns no exclusive target indefinitely. Publication,
    // not download selection or a restart, starts this finite window. Expiry
    // preserves the file in place and permits only a later explicit request;
    // it never classifies a provider outage as a failed file or starts a grab.
    if(claimReleasedMs===null&&publishedMs!==null&&nowMs>=publishedMs+15*60_000&&
        typeof acquisitions.releaseBonusClaimForReview==='function') {
      try{const released=acquisitions.releaseBonusClaimForReview({attemptId:item.attemptId,name:item.name,publishedMs,nowMs,reason});
        if(released?.state==='attention'){claimReleasedMs=released.releasedMs;currentStatus='attention';}}
      catch{/* Preserve exclusive ownership if the durable journal cannot update. */}
    }
    const nextCheckMs=nowMs+(claimReleasedMs===null?60_000:3600_000);
    save(currentStatus, { reason, delay: true });
    return claimReleasedMs===null?waiting(reason,nextCheckMs):
      {state:'bonus_review',attemptId:item.attemptId,name:item.name,reason,nextCheckMs};
  };
  let parent, plan, move;
  try {
    parent = acquisitions.getAttempt(item.attemptId);
    plan = acquisitions.getBonusPlan(item.attemptId);
    move = pureMoves.getIntent(item.attemptId);
  } catch { return retry('bonus_journal_unavailable'); }
  const matchingPlans = Array.isArray(plan) ? plan.filter((file) => sameFile(file, item)) : [];
  if (matchingPlans.length !== 1 || matchingPlans[0].evidence !== 'shoko_filename_prediction' ||
      (item.evidence !== undefined && item.evidence !== matchingPlans[0].evidence)) {
    return waiting('bonus_plan_conflict');
  }
  if (typeof parent?.torrentHash !== 'string' ||
      !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(parent.torrentHash) ||
      parent.expectedHash !== parent.torrentHash ||
      (parent.id !== undefined && parent.id !== item.attemptId)) return retry('bonus_parent_conflict');
  if (!move || !['published_observed', 'publish_unknown'].includes(move.status)) {
    return retry('bonus_publication_pending');
  }
  const manifest = move.manifest;
  if (manifest?.attemptId !== item.attemptId || manifest?.torrentHash !== parent.torrentHash ||
      !Array.isArray(manifest.files)) return retry('bonus_journal_conflict');
  const matches = manifest.files.filter((file) => typeof file?.name === 'string' &&
    file.name.toLowerCase() === item.name.toLowerCase());
  if (matches.length !== 1 || matches[0].scope !== 'bonus' || !sameFile(matches[0], matchingPlans[0])) {
    return retry('bonus_journal_conflict');
  }
  const journalFile = matches[0];
  if(move.status==='published_observed'&&Number.isSafeInteger(move.updatedMs)&&
      move.updatedMs>=0&&move.updatedMs<=clock())publishedMs=move.updatedMs;
  const publish = () => {
    if(claimReleasedMs!==null)return true;
    if (currentStatus === 'selected' || (currentStatus === 'attention' && !validId(currentFileId))) {
      return save('published');
    }
    return true;
  };
  if (move.status === 'published_observed' && !publish()) return retry('bonus_progress_conflict');
  let observation;
  try {
    // The synthetic observer view deliberately contains only this bonus's
    // journalled inode and its own AniDB identity, regardless of main status.
    observation = await observePureMoveImport({
      move: { status: move.status, manifest: { files: [{ name: journalFile.name,
        size: journalFile.size, episodeIds: [...journalFile.episodeIds],
        dev: journalFile.dev, ino: journalFile.ino, mtimeNs: journalFile.mtimeNs }] } },
      target: { anidbId: item.anidbId, episodeIds: [...item.episodeIds] },
      readEpisode, shokoMount, ...(probeImpl === undefined ? {} : { probeImpl }),
    });
  } catch { return retry('bonus_shoko_unavailable'); }
  if (observation?.state !== 'shoko_files_identified' || observation.files?.length !== 1 ||
      observation.files[0]?.name !== item.name || !validId(observation.files[0]?.fileId)) {
    return retry(observation?.reason ?? 'bonus_awaiting_shoko');
  }
  const fileId = observation.files[0].fileId;
  if (!publish() || !save('identified', { fileId })) return retry('bonus_progress_conflict');
  let proof;
  try {
    proof = await verifyPublic({ anidbId: item.anidbId, episodeId: item.episodeIds[0],
      fileId, kind: item.kind });
  } catch { return retry('bonus_public_unavailable'); }
  if (proof?.state !== 'playable' || proof.anidbId !== item.anidbId ||
      proof.episodeId !== item.episodeIds[0] || proof.fileId !== fileId) {
    return retry('bonus_public_proof_pending');
  }
  if (!save('playable', { fileId })) return retry('bonus_progress_conflict');
  return { state: 'bonus_playable', attemptId: item.attemptId, name: item.name,
    anidbId: item.anidbId, episodeId: item.episodeIds[0], fileId };
}
