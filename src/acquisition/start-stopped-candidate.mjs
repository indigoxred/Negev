import { createHash } from 'node:crypto';
import { readBoundedJson } from '../http/bounded-response.mjs';
import { observeStoppedManifest } from './observe-stopped-manifest.mjs';
import { evaluateStagingMountIsolation } from './staging-mount-isolation.mjs';

const held = (reason) => ({ state: 'held', reason });

// A one-send start boundary. Completion and AniDB identity are separate later
// gates; a successful HTTP response alone is never evidence of either.
export async function startStoppedCandidate({
  ledger, attemptId, expected, hostPath, inspectMounts, realpathImpl,
  baseUrl, sessionId, nowMs, fetchImpl = fetch, timeoutMs = 10_000,
}) {
  let base;
  try { base = new URL(baseUrl); } catch { throw new TypeError('Invalid qBittorrent URL'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
      base.pathname !== '/' || base.search || base.hash ||
      !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(expected?.hash) ||
      expected.category !== 'negev' || expected.savePath !== '/negev-staging' ||
      typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(sessionId) ||
      !Number.isSafeInteger(attemptId) || attemptId < 1 ||
      !Number.isSafeInteger(nowMs) || nowMs < 0 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 ||
      typeof inspectMounts !== 'function' || typeof realpathImpl !== 'function' ||
      typeof fetchImpl !== 'function' || typeof ledger?.beginStart !== 'function') {
    throw new TypeError('Invalid torrent start configuration');
  }
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
  const manifestDigest = createHash('sha256').update(JSON.stringify({
    videos: manifest.videos, subtitles: manifest.subtitles,
    savePath: paths.save_path, downloadPath: paths.download_path,
  })).digest('hex');
  const intent = ledger.beginStart({ attemptId, hash: expected.hash,
    manifestDigest, nowMs });
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
