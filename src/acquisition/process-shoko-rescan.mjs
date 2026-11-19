import path from 'node:path';
import { validMount } from '../availability/known-card-availability.mjs';

const held = (reason) => ({ state: 'held', reason });
const validId = (value) => Number.isSafeInteger(value) && value > 0;

const exactLink = (item, anidbId, episodeIds,
  requireLocalSeries = false) => {
  if (!Array.isArray(item.SeriesIDs)) return null;
  const linked = item.SeriesIDs.flatMap((series) =>
    series?.SeriesID?.AniDB === anidbId &&
      (!requireLocalSeries || validId(series?.SeriesID?.ID)) &&
      Array.isArray(series.EpisodeIDs)
      ? series.EpisodeIDs.map((episode) => episode.AniDB) : []);
  return linked.length === episodeIds.length &&
    [...linked].sort((a, b) => a - b).every((id, i) =>
      id === [...episodeIds].sort((a, b) => a - b)[i]);
};

export async function processShokoRescan({ item, ledger, importRoot,
  shokoMount, shokoSourcePath = null, readQueue, readFile, rescan,
  verifyPlex, nowMs } = {}) {
  const { attemptId, requestId, anidbId, publishedMs, manifest } = item ?? {};
  const videos = manifest?.files?.filter((file) =>
    Array.isArray(file.episodeIds));
  if (![attemptId, requestId, anidbId].every(validId) ||
      !Number.isSafeInteger(publishedMs) || publishedMs < 0 ||
      !Number.isSafeInteger(nowMs) || nowMs < publishedMs ||
      !Array.isArray(videos) || videos.length < 1 || videos.length > 50 ||
      typeof manifest.torrentHash !== 'string' ||
      !/^[a-f0-9]{40}$/i.test(manifest.torrentHash) ||
      !videos.every((file) => typeof file.name === 'string' && file.name &&
        validId(file.size) && file.episodeIds.length > 0 &&
        file.episodeIds.every(validId)) ||
      typeof importRoot !== 'string' || !path.isAbsolute(importRoot) ||
      !validMount(shokoMount) ||
      (shokoSourcePath !== null &&
        (typeof shokoSourcePath !== 'string' ||
          !path.posix.isAbsolute(shokoSourcePath) ||
          path.posix.normalize(shokoSourcePath) !== shokoSourcePath ||
          /[\0\r\n\\]/.test(shokoSourcePath) ||
          !validMount({ ...shokoMount, appRoot: shokoSourcePath }) ||
          (path.posix.relative(shokoMount.appRoot, shokoSourcePath) === '..' ||
            path.posix.relative(shokoMount.appRoot, shokoSourcePath)
              .startsWith('../')))) ||
      typeof ledger?.getFile !== 'function' ||
      typeof ledger?.observeFile !== 'function' ||
      typeof ledger?.beginDispatch !== 'function' ||
      typeof ledger?.markLinked !== 'function' ||
      typeof ledger?.markUnresolved !== 'function' ||
      typeof ledger?.delayAttempt !== 'function' ||
      typeof ledger?.endAttempt !== 'function' ||
      typeof readQueue !== 'function' || typeof readFile !== 'function' ||
      typeof rescan !== 'function' || typeof verifyPlex !== 'function') {
    throw new TypeError('Invalid Shoko rescan');
  }
  const reviewHold = (reason) => {
    ledger.endAttempt({ attemptId, review: true, nowMs });
    return held(reason);
  };
  if (nowMs - publishedMs < 300_000) return { state: 'awaiting_shoko' };
  let queue;
  try { queue = await readQueue(); }
  catch { queue = null; }
  if (queue?.state !== 'queue_idle_unverified') {
    if (nowMs - publishedMs >= 1_800_000) {
      return reviewHold('shoko_queue_never_settled');
    }
    ledger.delayAttempt({ attemptId, nextDueMs: nowMs + 60_000, nowMs });
    return { state: 'awaiting_shoko' };
  }
  let review = false;
  const recoveredEpisodes = [];
  for (const video of videos) {
    const prior = ledger.getFile(attemptId, video.name);
    if (prior && ['dispatched', 'linked'].includes(prior.status)) {
      let allPlayable = true;
      for (const episodeId of video.episodeIds) {
        let result;
        try { result = await verifyPlex({ requestId, anidbId, episodeId }); }
        catch { result = null; }
        if (result?.state !== 'available' || result.fileId !== prior.fileId) {
          allPlayable = false;
          break;
        }
      }
      if (allPlayable) {
        if (prior.status !== 'linked') ledger.markLinked({ attemptId,
          fileName: video.name, fileId: prior.fileId, nowMs });
        recoveredEpisodes.push(...video.episodeIds.map((episodeId) =>
          ({ episodeId, fileId: prior.fileId })));
        continue;
      }
    }
    const child = path.join(importRoot,
      `negev-${attemptId}-${manifest.torrentHash.slice(0, 16)}`);
    const local = path.join(child,
      ...video.name.split('/'));
    const insideChild = path.relative(child, local);
    if (!insideChild || insideChild === '..' ||
        insideChild.startsWith(`..${path.sep}`) ||
        path.isAbsolute(insideChild)) {
      return reviewHold('published_file_outside_tree');
    }
    const relative = path.relative(shokoMount.localRoot, local);
    if (shokoSourcePath === null && (!relative || relative === '..' ||
        relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))) {
      return reviewHold('shoko_source_outside_mount');
    }
    const sourcePath = shokoSourcePath === null
      ? path.posix.join(shokoMount.appRoot, ...relative.split(path.sep))
      : path.posix.join(shokoSourcePath, path.basename(importRoot),
        path.basename(child), ...insideChild.split(path.sep));
    let matches;
    try { matches = await readFile({ sourcePath }); }
    catch { matches = null; }
    if (!Array.isArray(matches) || matches.length > 100) {
      if (nowMs - publishedMs >= 1_200_000) {
        return reviewHold('shoko_file_unavailable');
      }
      ledger.delayAttempt({ attemptId, nextDueMs: nowMs + 60_000, nowMs });
      return held('shoko_file_unavailable');
    }
    const exact = matches.filter((file) => file?.Size === video.size &&
      validId(file.ID) && Array.isArray(file.Locations) &&
      file.Locations.some((location) =>
        location?.AbsolutePath === sourcePath &&
        location.IsAccessible === true));
    if (exact.length !== 1 || !Array.isArray(exact[0].SeriesIDs)) {
      if (nowMs - publishedMs >= 1_200_000) {
        return reviewHold('shoko_file_mismatch');
      }
      ledger.delayAttempt({ attemptId, nextDueMs: nowMs + 60_000, nowMs });
      return { state: 'awaiting_shoko' };
    }
    const file = exact[0];
    if (prior && prior.fileId !== file.ID) {
      return reviewHold('shoko_file_changed');
    }
    if (exactLink(file, anidbId, video.episodeIds, true)) {
      if (prior && prior.status !== 'linked') ledger.markLinked({ attemptId,
        fileName: video.name, fileId: file.ID, nowMs });
      if (prior) recoveredEpisodes.push(...video.episodeIds.map((episodeId) =>
        ({ episodeId, fileId: file.ID })));
      continue;
    }
    if (file.SeriesIDs.length > 0 &&
        !exactLink(file, anidbId, video.episodeIds)) {
      return reviewHold('shoko_identity_conflict');
    }
    if (prior?.status === 'unresolved') { review = true; continue; }
    if (prior?.status === 'linked') return reviewHold('shoko_link_lost');
    if (!prior) {
      const observed = ledger.observeFile({ attemptId,
        fileName: video.name, fileId: file.ID, nowMs });
      return observed.state === 'observed'
        ? { state: 'observed', requestId, attemptId }
        : observed;
    }
    if (prior.status === 'dispatched') {
      if (nowMs < prior.updatedMs + 300_000) {
        ledger.delayAttempt({ attemptId,
          nextDueMs: prior.updatedMs + 300_000, nowMs });
        return { state: 'awaiting_shoko' };
      }
      ledger.markUnresolved({ attemptId, fileName: video.name,
        fileId: file.ID, nowMs });
      return { state: 'rescan_unresolved', requestId, attemptId };
    }
    if (prior.status !== 'observed' ||
        nowMs < prior.firstSeenMs + 60_000) {
      ledger.delayAttempt({ attemptId,
        nextDueMs: prior.firstSeenMs + 60_000, nowMs });
      return { state: 'awaiting_shoko' };
    }
    const dispatch = ledger.beginDispatch({ attemptId,
      fileName: video.name, fileId: file.ID, nowMs });
    if (dispatch.state !== 'dispatched') return dispatch;
    let result;
    try { result = await rescan({ fileId: file.ID }); }
    catch { result = null; }
    return { state: result?.state === 'accepted'
      ? 'rescan_requested' : 'rescan_unconfirmed', requestId, attemptId };
  }
  for (const { episodeId, fileId } of recoveredEpisodes) {
    let publicResult;
    try { publicResult = await verifyPlex({ requestId, anidbId, episodeId }); }
    catch { publicResult = null; }
    if (publicResult?.state !== 'available' ||
        publicResult.fileId !== fileId) {
      if (nowMs - publishedMs >= 1_800_000) {
        return reviewHold('rescan_plex_unverified');
      }
      ledger.delayAttempt({ attemptId,
        nextDueMs: nowMs + 300_000, nowMs });
      return { state: 'awaiting_plex', requestId, attemptId };
    }
  }
  ledger.endAttempt({ attemptId, review, nowMs });
  return { state: review ? 'rescan_unresolved' : 'linked',
    requestId, attemptId };
}
