import { readBoundedJson } from '../http/bounded-response.mjs';
import { inspectTorrentMetainfo } from './inspect-torrent-metainfo.mjs';
import { observeStoppedManifest } from './observe-stopped-manifest.mjs';
import { evaluateStagingMountIsolation } from './staging-mount-isolation.mjs';
import { matchesStagingSavePath } from './staging-save-path.mjs';

const held = (reason) => ({ state: 'held', reason });
const validHash = (value) => typeof value === 'string' &&
  /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(value);

async function exactPreparedTorrent(prepared) {
  if (prepared?.state !== 'prepared_stopped' || !validHash(prepared.expected?.hash) ||
      prepared.expected.category !== 'negev' ||
      !matchesStagingSavePath(prepared.expected) ||
      !(prepared.form instanceof FormData)) return false;
  const form = prepared.form;
  const fields = [...form.keys()].sort();
  if (JSON.stringify(fields) !== JSON.stringify([
    'autoTMM', 'category', 'root_folder', 'savepath', 'skip_checking', 'stopped', 'torrents',
  ].sort()) || form.get('savepath') !== prepared.expected.savePath ||
      form.get('category') !== 'negev' || form.get('stopped') !== 'true' ||
      form.get('autoTMM') !== 'false' || form.get('skip_checking') !== 'false' ||
      form.get('root_folder') !== 'false') return false;
  const torrent = form.get('torrents');
  if (!(torrent instanceof Blob) || torrent.size < 1 || torrent.size > 2_000_000) return false;
  const metainfo = inspectTorrentMetainfo({ bytes: new Uint8Array(await torrent.arrayBuffer()) });
  return metainfo.state === 'metainfo_checked' &&
    metainfo.hash === prepared.expected.hash.toLowerCase();
}

// Server-only one-send boundary. No route invokes this yet. Fresh Docker mount
// evidence and a host realpath check are required on every call. An uncertain
// POST is reconciled by exact stopped observation, never retried.
export async function submitStoppedCandidate({
  ledger, attemptId, candidate, prepared, hostPath, inspectMounts, realpathImpl,
  baseUrl, sessionId, nowMs, fetchImpl = fetch, timeoutMs = 10_000,
}) {
  let base;
  try { base = new URL(baseUrl); } catch { throw new TypeError('Invalid qBittorrent URL'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
      base.pathname !== '/' || base.search || base.hash ||
      typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(sessionId) ||
      !Number.isSafeInteger(attemptId) || attemptId < 1 ||
      !Number.isSafeInteger(nowMs) || nowMs < 0 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 ||
      typeof inspectMounts !== 'function' || typeof realpathImpl !== 'function' ||
      typeof fetchImpl !== 'function' || !ledger ||
      typeof ledger.bindPreparedTorrent !== 'function' ||
      typeof ledger.beginDispatch !== 'function' ||
      typeof ledger.recordTorrent !== 'function') {
    throw new TypeError('Invalid stopped submission configuration');
  }
  if (!(await exactPreparedTorrent(prepared))) return held('prepared_torrent_mismatch');
  let mounts, realPath;
  try {
    mounts = await inspectMounts();
    realPath = await realpathImpl(hostPath);
  } catch { return held('mount_evidence_unavailable'); }
  const isolation = evaluateStagingMountIsolation(mounts, { hostPath });
  if (isolation.state !== 'isolated_mount') return isolation;
  if (realPath !== hostPath) return held('staging_path_not_canonical');

  const expected = prepared.expected;
  const bound = ledger.bindPreparedTorrent({ attemptId, candidate,
    hash: expected.hash, nowMs });
  if (bound.state === 'held') return bound;

  const headers = { Cookie: `SID=${sessionId}` };
  if (bound.state === 'prepared') {
    let existing;
    try {
      const url = new URL('/api/v2/torrents/info', base);
      url.searchParams.set('hashes', expected.hash);
      const response = await fetchImpl(url, { method: 'GET', headers,
        redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      if (response.status !== 200) return held('provider_unavailable');
      existing = await readBoundedJson(response, 100_000);
    } catch { return held('provider_unavailable'); }
    if (!Array.isArray(existing)) return held('provider_unavailable');
    if (existing.length !== 0) return held('torrent_hash_in_use');
    const intent = ledger.beginDispatch({ attemptId, nowMs });
    if (intent.state === 'held') return intent;
    if (intent.sendNow) {
      try {
        await fetchImpl(new URL('/api/v2/torrents/add', base), {
          method: 'POST', headers, body: prepared.form, redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch { /* Response is uncertain; observe by exact hash below. */ }
    }
  }

  const observed = await observeStoppedManifest({ baseUrl, sessionId, expected,
    fetchImpl, timeoutMs });
  if (observed.state !== 'manifest_safe') return observed;
  const recorded = ledger.recordTorrent({ attemptId, hash: expected.hash, nowMs });
  if (recorded.state !== 'torrent_observed') return recorded;
  return { state: 'stopped_observed', attemptId, hash: expected.hash,
    videos: observed.videos, subtitles: observed.subtitles };
}
