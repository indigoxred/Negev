import { createHash } from 'node:crypto';
import { readBoundedJson } from '../http/bounded-response.mjs';
import { observeStoppedManifest } from './observe-stopped-manifest.mjs';
import { evaluateStagingMountIsolation } from './staging-mount-isolation.mjs';
import { matchesStagingSavePath } from './staging-save-path.mjs';
import { confirmMissingTargets } from './confirm-missing-targets.mjs';

const held = (reason) => ({ state: 'held', reason });

// A one-send start boundary. Completion and AniDB identity are separate later
// gates; a successful HTTP response alone is never evidence of either.
export async function startStoppedCandidate({
  ledger, attemptId, expected, hostPath, inspectMounts, realpathImpl,
  baseUrl, sessionId, readRequest, readEvidence, publicLibraryIds,
  now = Date.now, fetchImpl = fetch, timeoutMs = 10_000,
}) {
  let base;
  try { base = new URL(baseUrl); } catch { throw new TypeError('Invalid qBittorrent URL'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
      base.pathname !== '/' || base.search || base.hash ||
      !matchesStagingSavePath(expected) || expected.category !== 'negev' ||
      typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(sessionId) ||
      !Number.isSafeInteger(attemptId) || attemptId < 1 ||
      typeof now !== 'function' || typeof readRequest !== 'function' ||
      typeof readEvidence !== 'function' ||
      !Array.isArray(publicLibraryIds) || publicLibraryIds.length < 1 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 ||
      typeof inspectMounts !== 'function' || typeof realpathImpl !== 'function' ||
      typeof fetchImpl !== 'function' || typeof ledger?.beginStart !== 'function' ||
      typeof ledger?.getAttempt !== 'function' ||
      typeof ledger?.getFilePlan !== 'function') {
    throw new TypeError('Invalid torrent start configuration');
  }
  const attempt = ledger.getAttempt(attemptId);
  if (attempt?.status !== 'torrent_observed' ||
      attempt.torrentHash !== expected.hash.toLowerCase()) return held('torrent_not_observed');
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
  let mounts, realPath;
  try {
    mounts = await inspectMounts();
    realPath = await realpathImpl(hostPath);
  } catch { return held('mount_evidence_unavailable'); }
  const isolation = evaluateStagingMountIsolation(mounts, { hostPath });
  if (isolation.state !== 'isolated_mount') return isolation;
  if (realPath !== hostPath) return held('staging_path_not_canonical');

  const manifest = await observeStoppedManifest({ baseUrl, sessionId, expected,
    fetchImpl, timeoutMs });
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
      headers: { Cookie: `SID=${sessionId}`, Accept: 'application/json' },
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
    episodeIds: attempt.episodeIds, readEvidence, publicLibraryIds, now });
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
    expected, fetchImpl, timeoutMs });
  if (finalManifest.state !== 'manifest_safe' ||
      JSON.stringify(finalManifest.videos) !== JSON.stringify(manifest.videos) ||
      JSON.stringify(finalManifest.subtitles) !== JSON.stringify(manifest.subtitles)) {
    return held('manifest_changed_before_start');
  }
  const manifestDigest = createHash('sha256').update(JSON.stringify({
    videos: manifest.videos, subtitles: manifest.subtitles,
    savePath: paths.save_path, downloadPath: paths.download_path,
  })).digest('hex');
  const intent = ledger.beginStart({ attemptId, hash: expected.hash,
    manifestDigest, nowMs: checked.checkedAtMs });
  if (intent.state === 'held' || !intent.sendNow) return intent;

  const body = new URLSearchParams({ hashes: expected.hash });
  try {
    await fetchImpl(new URL('/api/v2/torrents/start', base), {
      method: 'POST', headers: { Cookie: `SID=${sessionId}` }, body,
      redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
    });
  } catch { /* Start may have reached qBittorrent; never repeat automatically. */ }
  return { state: 'start_unknown', sendNow: true };
}
