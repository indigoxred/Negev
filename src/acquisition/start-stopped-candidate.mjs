import { createHash } from 'node:crypto';
import { readBoundedJson } from '../http/bounded-response.mjs';
import { observeStoppedManifest } from './observe-stopped-manifest.mjs';
import { evaluateStagingMountIsolation } from './staging-mount-isolation.mjs';
import { matchesStagingSavePath } from './staging-save-path.mjs';
import { confirmMissingTargets } from './confirm-missing-targets.mjs';
import { checkRelatedInstallment } from './related-installment-guard.mjs';
import { qbittorrentSessionCookie, validQbittorrentSessionId } from
  './qbittorrent-session-cookie.mjs';

const held = (reason) => ({ state: 'held', reason });

// A one-send start boundary. Completion and AniDB identity are separate later
// gates; a successful HTTP response alone is never evidence of either.
export async function startStoppedCandidate({
  ledger, attemptId, expected, hostPath, inspectMounts, realpathImpl,
  verifyStagingRoot, saveRoot,
  baseUrl, sessionId, readRequest, readEvidence, publicLibraryIds,
  readRelatedTitles,
  now = Date.now, fetchImpl = fetch, timeoutMs = 10_000,
}) {
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
      !Array.isArray(publicLibraryIds) || publicLibraryIds.length < 1 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 ||
      (typeof verifyStagingRoot !== 'function' &&
        (typeof inspectMounts !== 'function' || typeof realpathImpl !== 'function')) ||
      typeof fetchImpl !== 'function' || typeof ledger?.beginStart !== 'function' ||
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
  catch { return held('request_unavailable'); }
  if (request?.id !== attempt.requestId ||
      request.anidbId !== attempt.anidbId || request.status !== 'held' ||
      !Array.isArray(request.episodeIds) ||
      attempt.episodeIds.some((id) => !request.episodeIds.includes(id))) {
    return held('request_missing');
  }
  const plannedFiles = ledger.getFilePlan(attemptId);
  if (!plannedFiles) return held('file_plan_missing');
  if (readRelatedTitles) {
    let related;
    try { related = await readRelatedTitles({ anidbId: request.anidbId }); }
    catch { return held('related_title_unavailable'); }
    const checked = checkRelatedInstallment({ anidbId: request.anidbId,
      requestedTitle: request.title, related,
      fileNames: plannedFiles.map((file) => file.name) });
    if (checked.state !== 'related_title_clear') return checked;
  }
  const manifest = await observeStoppedManifest({ baseUrl, sessionId, expected,
    fetchImpl, timeoutMs, saveRoot });
  if (manifest.state !== 'manifest_safe') return manifest;
  const sorted = (files) => files.map((file) => [file.name, file.size])
    .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  if (JSON.stringify(sorted(manifest.videos)) !== JSON.stringify(sorted(plannedFiles))) {
    return held('file_plan_mismatch');
  }
  let paths;
  try {
    const url = new URL('/api/v2/torrents/properties', base);
    url.searchParams.set('hash', expected.hash);
    const response = await fetchImpl(url, { method: 'GET',
      headers: { Cookie: qbittorrentSessionCookie(sessionId),
        Accept: 'application/json' },
      redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    if (response.status !== 200) return held('storage_path_unverified');
    paths = await readBoundedJson(response, 100_000);
  } catch { return held('storage_path_unverified'); }
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
  let currentRequest;
  try { currentRequest = await readRequest(attempt.requestId); }
  catch { return held('request_unavailable'); }
  if (currentRequest?.id !== request.id ||
      currentRequest.anidbId !== request.anidbId ||
      currentRequest.status !== 'held' ||
      !Array.isArray(currentRequest.episodeIds) ||
      attempt.episodeIds.some((id) => !currentRequest.episodeIds.includes(id))) {
    return held('request_missing');
  }
  // The availability probe may take long enough for qBittorrent priorities or
  // paths to change. Recheck immediately before recording the one-send intent.
  const finalManifest = await observeStoppedManifest({ baseUrl, sessionId,
    expected, fetchImpl, timeoutMs, saveRoot });
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
    } catch { return held('staging_root_unverified'); }
  } else {
    let mounts, realPath;
    try {
      mounts = await inspectMounts();
      realPath = await realpathImpl(hostPath);
    } catch { return held('mount_evidence_unavailable'); }
    const finalIsolation = evaluateStagingMountIsolation(mounts, { hostPath });
    if (finalIsolation.state !== 'isolated_mount') return finalIsolation;
    if (realPath !== hostPath) return held('staging_path_not_canonical');
  }
  let startMs;
  try { startMs = now(); }
  catch { return held('availability_evidence_stale'); }
  if (!Number.isSafeInteger(startMs) || startMs < checked.checkedAtMs ||
      !Number.isSafeInteger(checked.observedAtMs) ||
      startMs - checked.observedAtMs > 30_000) {
    return held('availability_evidence_stale');
  }
  const manifestDigest = createHash('sha256').update(JSON.stringify({
    videos: manifest.videos, subtitles: manifest.subtitles,
    savePath: paths.save_path, downloadPath: paths.download_path,
  })).digest('hex');
  const intent = ledger.beginStart({ attemptId, hash: expected.hash,
    manifestDigest, nowMs: startMs });
  if (intent.state === 'held' || !intent.sendNow) return intent;

  const body = new URLSearchParams({ hashes: expected.hash });
  try {
    await fetchImpl(new URL('/api/v2/torrents/start', base), {
      method: 'POST', headers: { Cookie: qbittorrentSessionCookie(sessionId) }, body,
      redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
    });
  } catch { /* Start may have reached qBittorrent; never repeat automatically. */ }
  return { state: 'start_unknown', sendNow: true };
}
