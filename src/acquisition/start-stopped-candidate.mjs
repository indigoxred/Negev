import { collectAniDbDetail } from '../catalogue/collect-detail.mjs';
import { checkAcquisitionAccess } from './acquisition-access.mjs';
import { inferReleaseState } from '../catalogue/infer-release-state.mjs';
import { refreshBonusOwnership } from './bonus-ownership.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { readBoundedJson, cancelResponseBody } from '../http/bounded-response.mjs';
import { observeStoppedManifest } from './observe-stopped-manifest.mjs';
import { evaluateStagingMountIsolation } from './staging-mount-isolation.mjs';
import { matchesStagingSavePath } from './staging-save-path.mjs';
import { confirmMissingTargets } from './confirm-missing-targets.mjs';
import { checkRelatedInstallment } from './related-installment-guard.mjs';
import { acceptsShokoVideo } from './shoko-video-extensions.mjs';
import { qbittorrentSessionCookie, validQbittorrentSessionId } from
  './qbittorrent-session-cookie.mjs';

import { heldReporter } from '../runtime/held-diagnostics.mjs';
const held = (reason) => ({ state: 'held', reason });
const heldAfter = heldReporter('acquisition/start-stopped-candidate');

// A one-send start boundary. Completion and AniDB identity are separate later
// gates; a successful HTTP response alone is never evidence of either.
export async function startStoppedCandidate(options) {
  const {
  ledger, attemptId, expected, hostPath, inspectMounts, realpathImpl, authorizeRequest,
  verifyStagingRoot, saveRoot,
  baseUrl, sessionId, readRequest, readEvidence, publicLibraryIds,
  readRelatedTitles, loadDetail, releaseQueries, readVideoExtensions, readBonusOwnership,
  now = Date.now, fetchImpl = fetch, renewQbittorrent, timeoutMs = 10_000,
} = options;
  let base;
  try { base = new URL(baseUrl); } catch { throw new TypeError('Invalid qBittorrent URL'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
      base.pathname !== '/' || base.search || base.hash ||
      !matchesStagingSavePath(expected, { saveRoot }) || expected.category !== 'negev' ||
      !validQbittorrentSessionId(sessionId) ||
      !Number.isSafeInteger(attemptId) || attemptId < 1 ||
      typeof now !== 'function' || typeof readRequest !== 'function' ||
      typeof readEvidence !== 'function' ||
      (readRelatedTitles !== undefined && typeof readRelatedTitles !== 'function') ||
      (loadDetail !== undefined && typeof loadDetail !== 'function') ||
      (releaseQueries !== undefined && typeof releaseQueries !== 'function') ||
      (readVideoExtensions !== undefined && typeof readVideoExtensions !== 'function') ||
      !Array.isArray(publicLibraryIds) || publicLibraryIds.length < 1 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 ||
      (typeof verifyStagingRoot !== 'function' &&
        (typeof inspectMounts !== 'function' || typeof realpathImpl !== 'function')) ||
      typeof fetchImpl !== 'function' || typeof ledger?.beginStart !== 'function' ||
      (renewQbittorrent !== undefined && typeof renewQbittorrent !== 'function') ||
      typeof ledger?.getAttempt !== 'function' ||
      typeof ledger?.getFilePlan !== 'function') {
    throw new TypeError('Invalid torrent start configuration');
  }
  const attempt = ledger.getAttempt(attemptId);
  if (attempt?.status !== 'torrent_observed' ||
      attempt.torrentHash !== expected.hash.toLowerCase()) return held('torrent_not_observed');
  if (attempt.evidencePolicy !== undefined &&
      attempt.evidencePolicy !== 'first_time_permissive') {
    return held('attempt_policy_invalid');
  }
  let request;
  try { request = await readRequest(attempt.requestId); }
  catch (error) { return heldAfter(error, 'request_unavailable'); }
  if (request?.id !== attempt.requestId ||
      request.anidbId !== attempt.anidbId || request.status !== 'held' ||
      !Array.isArray(request.episodeIds) ||
      attempt.episodeIds.some((id) => !request.episodeIds.includes(id))) {
    return held('request_missing');
  }
  const plannedFiles = ledger.getFilePlan(attemptId);
  if (!plannedFiles) return held('file_plan_missing');
  if (plannedFiles.length > 50 || attempt.episodeIds.length > 50) {
    if (typeof loadDetail !== 'function') return held('detail_unavailable');
    const detail = await collectAniDbDetail({ anidbId: request.anidbId, loadPage: loadDetail });
    if (detail.state !== 'details' || detail.kind !== request.kind) return held('detail_unavailable');
    if (request.kind !== 'series' || inferReleaseState({ ...detail,
        today: new Date(now()).toISOString().slice(0,10) }).state !== 'completed') {
      return held('large_pack_requires_completed_series');
    }
    const regular = new Set(detail.episodes.filter(e => e.type === 'Episode').map(e => e.id));
    if (attempt.episodeIds.some(id => !regular.has(id))) return held('file_plan_mismatch');
  }
  let bonusFiles=ledger.getBonusPlan?.(attemptId)??[];
  let extensions;
  if (readVideoExtensions) {
    try { extensions = await readVideoExtensions(); }
    catch (error) { return heldAfter(error, 'shoko_settings_unavailable'); }
    if (extensions?.state !== 'extensions') return held('shoko_settings_unavailable');
    if (plannedFiles.some((file) => !acceptsShokoVideo(file.name, extensions))) {
      return held('shoko_video_format_unsupported');
    }
  }
  if (readRelatedTitles) {
    let related;
    try { related = await readRelatedTitles({ anidbId: request.anidbId }); }
    catch (error) { return heldAfter(error, 'related_title_unavailable'); }
    // Refresh the same-ID authority used at preflight; saved UI titles and
    // torrent filenames cannot manufacture trusted aliases at the start boundary.
    let requestedTitle=request.title,requestedAliases=[];
    if(loadDetail){
      let detail;
      try{detail=await loadDetail({anidbId:request.anidbId});}
      catch (error) { return heldAfter(error, 'detail_unavailable'); }
      if(detail?.state!=='details'||detail.anidbId!==request.anidbId||
        detail.kind!==request.kind||typeof detail.title!=='string'||!detail.title.trim())return held('detail_unavailable');
      requestedTitle=detail.title;
    }
    if(releaseQueries){
      try{requestedAliases=await releaseQueries({anidbId:request.anidbId});}
      catch (error) { return heldAfter(error, 'related_title_unavailable'); }
      if(!Array.isArray(requestedAliases)||requestedAliases.some(title=>typeof title!=='string'))return held('related_title_unavailable');
    }
    const checked = checkRelatedInstallment({ anidbId: request.anidbId,
      requestedTitle, requestedAliases, related,
      fileNames: plannedFiles.map((file) => file.name) });
    if (checked.state !== 'related_title_clear') return checked;
  }
  if(bonusFiles.length){
    const supported=extensions?bonusFiles.filter(file=>acceptsShokoVideo(file.name,extensions)):bonusFiles;
    const refreshed=await refreshBonusOwnership({files:supported,readOwnership:readBonusOwnership});
    const kept=new Set(refreshed.files.map(file=>file.name));
    const exclude=bonusFiles.filter(file=>!kept.has(file.name));
    if(exclude.length){
      if(typeof ledger.excludeUnstartedBonuses!=='function')return held('bonus_exclusion_unavailable');
      const saved=ledger.excludeUnstartedBonuses({attemptId,names:exclude.map(file=>file.name),nowMs:now()});
      if(saved.state!=='excluded')return saved;
    }
    bonusFiles=ledger.getBonusPlan(attemptId);
  }
  const selectedFiles=[...plannedFiles,...bonusFiles];
  const plannedFileNames=selectedFiles.map(file=>file.name);
  let activeSessionId = sessionId;
  let activeFetch = fetchImpl;
  const renewSession = async () => {
    if (!renewQbittorrent) return held('provider_http_403');
    let renewed;
    try { renewed = await renewQbittorrent(activeSessionId); }
    catch (error) { return heldAfter(error, 'authentication_unavailable'); }
    if (renewed?.state !== 'authenticated') {
      return held(typeof renewed?.reason === 'string' ? renewed.reason :
        'authentication_unavailable');
    }
    if (!validQbittorrentSessionId(renewed.sessionId) ||
        typeof renewed.fetchImpl !== 'function') {
      return held('authentication_unavailable');
    }
    activeSessionId = renewed.sessionId;
    activeFetch = renewed.fetchImpl;
    return { state: 'authenticated' };
  };
  let manifest = await observeStoppedManifest({ baseUrl,
    sessionId: activeSessionId, expected, fetchImpl: activeFetch,
    timeoutMs, saveRoot, plannedFileNames, allowSelectedPassive:true });
  if (manifest.reason === 'provider_http_403') {
    const renewed = await renewSession();
    if (renewed.state !== 'authenticated') return renewed;
    manifest = await observeStoppedManifest({ baseUrl,
      sessionId: activeSessionId, expected, fetchImpl: activeFetch,
      timeoutMs, saveRoot, plannedFileNames, allowSelectedPassive:true });
  }
  if(manifest.state==='manifest_needs_exclusions'){
    const body=new URLSearchParams({hash:expected.hash,id:manifest.passive.map(file=>String(file.index)).join('|'),priority:'0'});
    try{const receipt=await activeFetch(new URL('/api/v2/torrents/filePrio',base),{method:'POST',headers:{Cookie:qbittorrentSessionCookie(activeSessionId)},body,redirect:'manual',signal:AbortSignal.timeout(timeoutMs)});await cancelResponseBody(receipt);}catch{/* Exact re-observation decides whether exclusion succeeded. */}
    manifest=await observeStoppedManifest({baseUrl,sessionId:activeSessionId,expected,fetchImpl:activeFetch,timeoutMs,saveRoot,plannedFileNames});
  }
  if (manifest.state !== 'manifest_safe') return manifest;
  let manifestAtMs;
  try { manifestAtMs = now(); }
  catch (error) { return heldAfter(error, 'availability_evidence_stale'); }
  if (!Number.isSafeInteger(manifestAtMs) || manifestAtMs < 0) {
    return held('availability_evidence_stale');
  }
  const sorted = (files) => files.map((file) => [file.name, file.size])
    .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  if (JSON.stringify(sorted(manifest.videos)) !== JSON.stringify(sorted(selectedFiles))) {
    return held('file_plan_mismatch');
  }
  let paths;
  try {
    const url = new URL('/api/v2/torrents/properties', base);
    url.searchParams.set('hash', expected.hash);
    const response = await activeFetch(url, { method: 'GET',
      headers: { Cookie: qbittorrentSessionCookie(activeSessionId),
        Accept: 'application/json' },
      redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    if (response.status !== 200) { await cancelResponseBody(response); return held(response.status===403?'provider_http_403':'provider_unavailable'); }
    paths = await readBoundedJson(response, 100_000);
  } catch (error) { return heldAfter(error, 'provider_unavailable'); }
  if (paths?.save_path !== expected.savePath ||
      typeof paths.download_path !== 'string') return held('storage_path_unverified');
  if (paths.download_path !== '' && paths.download_path !== expected.savePath) {
    return held('incomplete_path_outside_staging');
  }
  const checked = await confirmMissingTargets({ request,
    episodeIds: attempt.episodeIds, readEvidence, publicLibraryIds,
    firstTimePolicy: attempt.evidencePolicy === 'first_time_permissive'
      ? 'single_uncertain_attempt' : 'strict', now });
  if (checked.state !== 'missing_confirmed') return checked;
  if (checked.checkedAtMs < manifestAtMs) {
    return held('availability_evidence_stale');
  }
  let currentRequest;
  try { currentRequest = await readRequest(attempt.requestId); }
  catch (error) { return heldAfter(error, 'request_unavailable'); }
  if (currentRequest?.id !== request.id ||
      currentRequest.anidbId !== request.anidbId ||
      currentRequest.status !== 'held' ||
      !Array.isArray(currentRequest.episodeIds) ||
      attempt.episodeIds.some((id) => !currentRequest.episodeIds.includes(id))) {
    return held('request_missing');
  }
  const access = ledger.getStart?.(attemptId) ? { state: 'authorized' }
    : await checkAcquisitionAccess(authorizeRequest, { requestId: request.id, attemptId });
  if (access.state === 'held') return access;
  // The availability probe may take long enough for qBittorrent priorities or
  // paths to change. Recheck immediately before recording the one-send intent.
  let refreshedForFinal = false;
  if (renewQbittorrent && checked.checkedAtMs - manifestAtMs >= 60_000) {
    const renewed = await renewSession();
    if (renewed.state !== 'authenticated') return renewed;
    refreshedForFinal = true;
  }
  let finalManifest = await observeStoppedManifest({ baseUrl,
    sessionId: activeSessionId, expected, fetchImpl: activeFetch,
    timeoutMs, saveRoot });
  if (finalManifest.reason === 'provider_http_403') {
    if (refreshedForFinal) return finalManifest;
    const renewed = await renewSession();
    if (renewed.state !== 'authenticated') return renewed;
    finalManifest = await observeStoppedManifest({ baseUrl,
      sessionId: activeSessionId, expected, fetchImpl: activeFetch,
      timeoutMs, saveRoot });
  }
  if (finalManifest.reason === 'provider_http_403' ||
      finalManifest.reason === 'provider_unavailable') return finalManifest;
  if (finalManifest.state !== 'manifest_safe' ||
      JSON.stringify(finalManifest.videos) !== JSON.stringify(manifest.videos) ||
      JSON.stringify(finalManifest.subtitles) !== JSON.stringify(manifest.subtitles)) {
    return held('manifest_changed_before_start');
  }
  if (verifyStagingRoot) {
    try {
      if ((await verifyStagingRoot())?.state !== 'verified_staging_root') {
        return held('staging_root_unverified');
      }
    } catch (error) { return heldAfter(error, 'staging_root_unverified'); }
  } else {
    let mounts, realPath;
    try {
      mounts = await inspectMounts();
      realPath = await realpathImpl(hostPath);
    } catch (error) { return heldAfter(error, 'mount_evidence_unavailable'); }
    const finalIsolation = evaluateStagingMountIsolation(mounts, { hostPath });
    if (finalIsolation.state !== 'isolated_mount') return finalIsolation;
    if (realPath !== hostPath) return held('staging_path_not_canonical');
  }
  let startMs;
  try { startMs = now(); }
  catch (error) { return heldAfter(error, 'availability_evidence_stale'); }
  if (!Number.isSafeInteger(startMs) || startMs < checked.checkedAtMs ||
      !Number.isSafeInteger(checked.observedAtMs) ||
      startMs - checked.observedAtMs > 30_000) {
    return held('availability_evidence_stale');
  }
  const manifestDigest = createHash('sha256').update(JSON.stringify({
    videos: manifest.videos, subtitles: manifest.subtitles,
    savePath: paths.save_path, downloadPath: paths.download_path,
  })).digest('hex');
  const sendToken = randomUUID();
  const intent = ledger.beginStart({ attemptId, hash: expected.hash, restricted: access.restricted,
    manifestDigest, nowMs: startMs, sendToken });
  if (intent.state === 'held' || !intent.sendNow) return intent;

  const body = new URLSearchParams({ hashes: expected.hash });
  let response;
  try {
    response = await activeFetch(new URL('/api/v2/torrents/start', base), {
      method: 'POST', headers: { Cookie: qbittorrentSessionCookie(activeSessionId) }, body,
      redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // A timeout/disconnect may follow acceptance. Its intent remains one-send.
    return {state:'start_unknown',sendNow:true};
  }
  await cancelResponseBody(response);
  if(response.status===403 && typeof ledger.rejectStart==='function') {
      // Only an explicit HTTP authentication rejection establishes non-acceptance.
      // Bind that receipt to this send, so a stale/concurrent worker cannot clear
      // a newer uncertain intent. Rejections remain durable across restarts.
      const rejected=ledger.rejectStart({attemptId,hash:expected.hash.toLowerCase(),manifestDigest,sendToken,nowMs:now()});
      if(rejected.state!=='start_rejected')return {state:'start_unknown',sendNow:true};
      if(options.retryRejectedStart===false)return held('provider_http_403');
      const renewed=await renewSession();
      if(renewed.state!=='authenticated')return renewed;
      return startStoppedCandidate({...options,sessionId:activeSessionId,fetchImpl:activeFetch,renewQbittorrent:undefined,retryRejectedStart:false});
    }
  return { state: 'start_unknown', sendNow: true };
}
