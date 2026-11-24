import { MAX_ACQUISITION_VIDEOS } from './torrent-file-limits.mjs';
import path from 'node:path';
import { probePureMovedFile } from './observe-pure-move-import.mjs';
import { localPath, validMount } from '../availability/known-card-availability.mjs';

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
  verifyPlex, probeImpl = probePureMovedFile, hydrateMetadata = null, readUnrecognized = null, readMetadata = null, nowMs, now = () => nowMs } = {}) {
  const { attemptId, requestId, anidbId, publishedMs, manifest } = item ?? {};
  const videos = manifest?.files?.filter((file) =>
    file.scope !== 'bonus' && Array.isArray(file.episodeIds));
  if (![attemptId, requestId, anidbId].every(validId) ||
      !Number.isSafeInteger(publishedMs) || publishedMs < 0 ||
      !Number.isSafeInteger(nowMs) || nowMs < publishedMs ||
      !Array.isArray(videos) || videos.length < 1 || videos.length > MAX_ACQUISITION_VIDEOS ||
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
      typeof probeImpl !== 'function' || typeof now !== 'function' || typeof rescan !== 'function' || typeof verifyPlex !== 'function' ||
      (hydrateMetadata !== null && typeof hydrateMetadata !== 'function') ||
      (readUnrecognized !== null && typeof readUnrecognized !== 'function') ||
      (readMetadata !== null && typeof readMetadata !== 'function')) {
    throw new TypeError('Invalid Shoko rescan');
  }
  const reviewHold = (reason) => {
    ledger.recordObservation?.({attemptId,state:'review',reason,nowMs});
    ledger.endAttempt({ attemptId, review: true, nowMs });
    return held(reason);
  };
  if (nowMs - publishedMs < 300_000) return { state: 'awaiting_shoko' };
  const delay = (state, reason, ms = 60_000) => {
    ledger.delayAttempt({ attemptId, nextDueMs: nowMs + ms, nowMs });
    ledger.recordObservation?.({attemptId, state, reason, nowMs});
    return { state, reason, requestId, attemptId };
  };
  let queue;
  const queueReady = async () => {
    if (queue === undefined) {
      try { queue = await readQueue(); } catch { queue = null; }
    }
    return queue?.state === 'queue_idle_unverified';
  };
  let review = false;
  let pending = null;
  let dispatched = 0;
  const pendingRank = {awaiting_shoko:0,rescan_unresolved:1,observed:2,rescan_unconfirmed:3,rescan_requested:4};
  const notePending = (state) => { if (!pending || pendingRank[state]>pendingRank[pending]) pending=state; };
  const deferred = [];
  const deferFile = (state, reason) => deferred.push({state,reason});
  const recoveredEpisodes = [];
  files: for (const video of videos) {
    const prior = ledger.getFile(attemptId, video.name);
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
    // Availability of another copy does not establish this attempt's ownership.
    // Check the publication journal before adopting or reusing any Shoko ID.
    if (![video.dev, video.ino, video.mtimeNs].every(value =>
      typeof value === 'string' && /^\d+$/.test(value))) {
      deferFile('held', 'published_identity_missing'); continue files;
    }
    const physicallyMatches = async (file) => {
      if (!Array.isArray(file?.Locations) || file.Locations.length > 20) return false;
      for (const location of file.Locations) {
        if (location?.IsAccessible !== true) continue;
        const source = location.AbsolutePath;
        const filePath = source === sourcePath ? local : localPath(source, shokoMount);
        if (!filePath) continue;
        let probe;
        try { probe = await probeImpl({filePath, allowedRoot:
          source === sourcePath ? importRoot : shokoMount.localRoot,
          expectedSize: video.size}); } catch { continue; }
        if (probe?.state === 'candidate' && probe.candidateKey ===
          `${video.dev}:${video.ino}:${video.size}:${video.mtimeNs}`) return true;
      }
      return false;
    };
    let matches;
    try { matches = await readFile({ sourcePath }); }
    catch { matches = null; }
    if (!Array.isArray(matches) || matches.length > 100) {
      deferFile('held','shoko_provider_unavailable'); continue files;
    }
    const exact = matches.filter((file) => file?.Size === video.size &&
      validId(file.ID) && Array.isArray(file.Locations) &&
      file.Locations.some((location) =>
        location?.AbsolutePath === sourcePath &&
        location.IsAccessible === true));
    // A normal first-pass import can move the file before this delayed check.
    // The old source path then vanishes. Look up only the same basename and
    // require exact episode and physical identity. Shoko may reuse an older
    // logical record, so its Created timestamp cannot prove file ownership.
    const occupiedSource = matches.some(file => Array.isArray(file?.Locations) &&
      file.Locations.some(location => location?.AbsolutePath === sourcePath &&
        location.IsAccessible === true));
    if (exact.length === 0 && !occupiedSource) {
      // Path lookup can retain an inaccessible source location on the same
      // logical record after Shoko moves its physical file.
      let moved = matches;
      if (matches.length === 0) {
        try { moved = await readFile({ sourcePath:
          `/${path.posix.basename(video.name)}` }); }
        catch { moved = null; }
      }
      if (!Array.isArray(moved) || moved.length > 100) { deferFile('held','shoko_provider_unavailable'); continue files; }
      if (Array.isArray(moved) && moved.length <= 100) {
        const confirmed = [];
        for (const file of moved) {
          const inMount = file?.Locations?.some((location) => {
            const absolute = location?.AbsolutePath;
            if (typeof absolute !== 'string' ||
                path.posix.normalize(absolute) !== absolute ||
                location.IsAccessible !== true || absolute === sourcePath ||
                path.posix.basename(absolute) !== path.posix.basename(video.name)) {
              return false;
            }
            const relative = path.posix.relative(shokoMount.appRoot, absolute);
            return relative && relative !== '..' && !relative.startsWith('../') &&
              !path.posix.isAbsolute(relative);
          });
          if (!validId(file?.ID) || file.Size !== video.size || !inMount ||
              !exactLink(file, anidbId, video.episodeIds, true)) continue;
          if (await physicallyMatches(file)) confirmed.push(file);
        }
        if (confirmed.length > 1) {
          reviewHold('shoko_identity_ambiguous'); review = true; continue;
        }
        if (confirmed.length === 1 && (!prior || prior.fileId === confirmed[0].ID)) {
          const fileId = confirmed[0].ID;
          if (!prior) {
            const observed = ledger.observeFile({ attemptId,
              fileName: video.name, fileId, nowMs });
            if (observed.state !== 'observed') return observed;
          }
          const linked = ledger.markLinked({ attemptId,
            fileName: video.name, fileId, nowMs });
          if (linked.state !== 'linked') return linked;
          recoveredEpisodes.push(...video.episodeIds.map((episodeId) =>
            ({ episodeId, fileId })));
          continue;
        }
      }
    }
    if (exact.length !== 1 || !Array.isArray(exact[0].SeriesIDs)) {
      if (exact.length > 1) { reviewHold('shoko_identity_ambiguous'); review=true; continue; }
      deferFile('awaiting_shoko',matches.length ? 'shoko_file_mismatch' : 'shoko_processing'); continue files;
    }
    const file = exact[0];
    if (!await physicallyMatches(file)) {
      deferFile('awaiting_shoko', 'published_file_unverified'); continue files;
    }
    if (prior && prior.fileId !== file.ID) {
      reviewHold('shoko_file_changed'); review=true; continue;
    }
    if (exactLink(file, anidbId, video.episodeIds, true)) {
      if (!prior) {
        const observed = ledger.observeFile({attemptId,fileName:video.name,fileId:file.ID,nowMs});
        if (observed.state !== 'observed') return observed;
      }
      if (prior?.status !== 'linked') ledger.markLinked({ attemptId,
        fileName: video.name, fileId: file.ID, nowMs });
      recoveredEpisodes.push(...video.episodeIds.map((episodeId) =>
        ({ episodeId, fileId: file.ID })));
      continue;
    }
    if (file.SeriesIDs.length > 0 &&
        !exactLink(file, anidbId, video.episodeIds)) {
      reviewHold('shoko_identity_conflict'); review=true; continue;
    }
    if (readMetadata) {
      for (const episodeId of video.episodeIds) {
        let metadata;
        try { metadata = await readMetadata({anidbId,episodeId}); } catch { metadata = null; }
        if (metadata?.state === 'missing') {
          if (hydrateMetadata) {
            try { await hydrateMetadata({anidbId,missingEpisodeId:episodeId}); }
            catch { deferFile('held','shoko_provider_unavailable'); continue files; }
          }
          deferFile('awaiting_shoko','shoko_metadata_missing'); continue files;
        }
        if (metadata?.state !== 'present') { deferFile('held','shoko_provider_unavailable'); continue files; }
      }
    }
    if (file.SeriesIDs.length && hydrateMetadata) {
      try { await hydrateMetadata({anidbId,missingEpisodeId:video.episodeIds[0]}); }
      catch { deferFile('held','shoko_provider_unavailable'); continue files; }
    }
    if (prior?.status === 'unresolved' && readUnrecognized && !file.SeriesIDs.length) {
      let classification;
      try { classification = await readUnrecognized({fileId:file.ID}); } catch { classification = null; }
      if (classification?.state !== 'unrecognized') { deferFile('awaiting_shoko',
        classification?.state === 'not_unrecognized' ? 'shoko_processing' : 'shoko_provider_unavailable'); continue files; }
    }
    if (prior?.status === 'unresolved') {
      review = true;
      ledger.recordObservation?.({attemptId,state:'review',reason:
        file.SeriesIDs.length ? 'shoko_metadata_missing' : readUnrecognized ? 'shoko_unrecognized_file' : 'registration_unconfirmed',nowMs});
      continue;
    }
    if (prior?.status === 'linked') { reviewHold('shoko_link_lost'); review=true; continue; }
    if (!await queueReady()) { deferFile('awaiting_shoko',
      !queue?.state || queue.state === 'unavailable' ? 'shoko_provider_unavailable' : 'shoko_processing'); continue files; }
    if (!prior) {
      const observed = ledger.observeFile({ attemptId,
        fileName: video.name, fileId: file.ID, nowMs });
      if (observed.state !== 'observed') return observed;
      notePending('observed'); continue;
    }
    if (prior.status === 'dispatched') {
      if (nowMs < prior.updatedMs + 300_000) {
        ledger.delayAttempt({ attemptId,
          nextDueMs: prior.updatedMs + 300_000, nowMs });
        notePending('awaiting_shoko'); continue;
      }
      ledger.markUnresolved({ attemptId, fileName: video.name,
        fileId: file.ID, nowMs });
      notePending('rescan_unresolved'); continue;
    }
    if (prior.status !== 'observed' ||
        nowMs < prior.firstSeenMs + 60_000) {
      ledger.delayAttempt({ attemptId,
        nextDueMs: prior.firstSeenMs + 60_000, nowMs });
      notePending('awaiting_shoko'); continue;
    }
    if (dispatched >= 4) { notePending('awaiting_shoko'); continue; }
    const dispatch = ledger.beginDispatch({ attemptId,
      fileName: video.name, fileId: file.ID, nowMs });
    if (dispatch.state !== 'dispatched') return dispatch;
    let result;
    try { result = await rescan({ fileId: file.ID }); }
    catch { result = null; }
    ledger.recordDispatchResult?.({attemptId,fileName:video.name,fileId:file.ID,
      result:result?.state==='accepted'?'accepted':'unconfirmed',nowMs:Math.max(nowMs,now())});
    dispatched++;
    notePending(result?.state === 'accepted' ? 'rescan_requested' : 'rescan_unconfirmed');
  }
  for (const { episodeId, fileId } of recoveredEpisodes) {
    let publicResult;
    try { publicResult = await verifyPlex({ requestId, anidbId, episodeId }); }
    catch { publicResult = null; }
    if (publicResult?.state !== 'available' ||
        publicResult.fileId !== fileId) {
      return delay('awaiting_plex','plex_publication_pending');
    }
  }
  if (deferred.length) return delay(deferred[0].state,deferred[0].reason);
  if (pending) {
    ledger.delayAttempt({attemptId,nextDueMs:nowMs+60_000,nowMs});
    return {state:pending,requestId,attemptId};
  }
  if (!review) ledger.recordObservation?.({attemptId,state:'linked',reason:'playable',nowMs});
  ledger.endAttempt({ attemptId, review, nowMs });
  return { state: review ? 'rescan_unresolved' : 'linked',
    requestId, attemptId };
}
