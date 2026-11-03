import { readBoundedJson, readBoundedText } from '../http/bounded-response.mjs';
import { inspectTorrentMetainfo } from './inspect-torrent-metainfo.mjs';
import { observeStoppedManifest } from './observe-stopped-manifest.mjs';
import { evaluateStagingMountIsolation } from './staging-mount-isolation.mjs';
import { matchesStagingSavePath } from './staging-save-path.mjs';
import { qbittorrentSessionCookie, validQbittorrentSessionId } from
  './qbittorrent-session-cookie.mjs';

const held = (reason) => ({ state: 'held', reason });
const validHash = (value) => typeof value === 'string' &&
  /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(value);

async function exactPreparedTorrent(prepared, saveRoot) {
  if (prepared?.state !== 'prepared_stopped' || !validHash(prepared.expected?.hash) ||
      prepared.expected.category !== 'negev' ||
      !matchesStagingSavePath(prepared.expected, { saveRoot }) ||
      !(prepared.form instanceof FormData)) return null;
  const form = prepared.form;
  const fields = [...form.keys()].sort();
  if (JSON.stringify(fields) !== JSON.stringify([
    'autoTMM', 'category', 'contentLayout', 'savepath', 'skip_checking', 'stopped', 'torrents',
  ].sort()) || form.get('savepath') !== prepared.expected.savePath ||
      form.get('category') !== 'negev' || form.get('stopped') !== 'true' ||
      form.get('autoTMM') !== 'false' || form.get('skip_checking') !== 'false' ||
      form.get('contentLayout') !== 'NoSubfolder') return null;
  const torrent = form.get('torrents');
  if (!(torrent instanceof Blob) || torrent.size < 1 || torrent.size > 2_000_000) return null;
  const metainfo = inspectTorrentMetainfo({ bytes: new Uint8Array(await torrent.arrayBuffer()) });
  return metainfo.state === 'metainfo_checked' &&
    metainfo.hash === prepared.expected.hash.toLowerCase() ? metainfo : null;
}

// Server-only one-send boundary. Fresh local staging evidence is required
// before each write. An uncertain POST is reconciled by exact stopped
// observation, never retried.
export async function submitStoppedCandidate({
  ledger, attemptId, candidate, prepared, hostPath, inspectMounts, realpathImpl,
  verifyStagingRoot, saveRoot,
  baseUrl, sessionId, nowMs, fetchImpl = fetch, timeoutMs = 10_000,
}) {
  let base;
  try { base = new URL(baseUrl); } catch { throw new TypeError('Invalid qBittorrent URL'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
      base.pathname !== '/' || base.search || base.hash ||
      !validQbittorrentSessionId(sessionId) ||
      !Number.isSafeInteger(attemptId) || attemptId < 1 ||
      !Number.isSafeInteger(nowMs) || nowMs < 0 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 ||
      (typeof verifyStagingRoot !== 'function' &&
        (typeof inspectMounts !== 'function' || typeof realpathImpl !== 'function')) ||
      typeof fetchImpl !== 'function' || !ledger ||
      typeof ledger.bindPreparedTorrent !== 'function' ||
      typeof ledger.beginDispatch !== 'function' ||
      typeof ledger.recordTorrent !== 'function') {
    throw new TypeError('Invalid stopped submission configuration');
  }
  const metainfo = await exactPreparedTorrent(prepared, saveRoot);
  if (!metainfo) return held('prepared_torrent_mismatch');
  const checkMounts = async () => {
    if (verifyStagingRoot) {
      try {
        const result = await verifyStagingRoot();
        return result?.state === 'verified_staging_root'
          ? { state: 'isolated_mount' } : held('staging_root_unverified');
      } catch { return held('staging_root_unverified'); }
    }
    let mounts, realPath;
    try {
      mounts = await inspectMounts();
      realPath = await realpathImpl(hostPath);
    } catch { return held('mount_evidence_unavailable'); }
    const isolation = evaluateStagingMountIsolation(mounts, { hostPath });
    if (isolation.state !== 'isolated_mount') return isolation;
    return realPath === hostPath ? isolation :
      held('staging_path_not_canonical');
  };

  const expected = prepared.expected;
  let addAttempted = false;
  const bound = ledger.bindPreparedTorrent({ attemptId, candidate,
    hash: expected.hash, nowMs });
  if (bound.state === 'held') return bound;

  const headers = { Cookie: qbittorrentSessionCookie(sessionId) };
  if (bound.state === 'prepared') {
    let version;
    try {
      const response = await fetchImpl(new URL('/api/v2/app/version', base), {
        method: 'GET', headers, redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status !== 200) return held('provider_unavailable');
      version = (await readBoundedText(response, 32)).trim();
    } catch { return held('provider_unavailable'); }
    // The stopped-add form was reviewed against qBittorrent 5.3.0. Hold
    // other minor versions until their API behavior is checked explicitly.
    if (!/^v?5\.3\.\d+$/.test(version)) {
      return held('unsupported_qbittorrent_version');
    }
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
    const isolation = await checkMounts();
    if (isolation.state !== 'isolated_mount') return isolation;
    const intent = ledger.beginDispatch({ attemptId, nowMs });
    if (intent.state === 'held') return intent;
    if (intent.sendNow) {
      addAttempted = true;
      try {
        await fetchImpl(new URL('/api/v2/torrents/add', base), {
          method: 'POST', headers, body: prepared.form, redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch { /* Response is uncertain; observe by exact hash below. */ }
    }
  }

  if (bound.state !== 'prepared') {
    const isolation = await checkMounts();
    if (isolation.state !== 'isolated_mount') return isolation;
  }

  let observed = await observeStoppedManifest({ baseUrl, sessionId, expected,
    fetchImpl, timeoutMs, allowSelectedPassive: true,
    expectedFiles: metainfo.files, saveRoot });
  // qBittorrent may acknowledge an add before its torrent list exposes the
  // new hash. Re-read the exact hash briefly; never send another add.
  for (let retry = 0; addAttempted && observed.reason === 'torrent_unavailable' &&
      retry < 5; retry++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    observed = await observeStoppedManifest({ baseUrl, sessionId, expected,
      fetchImpl, timeoutMs, allowSelectedPassive: true,
      expectedFiles: metainfo.files, saveRoot });
  }
  if (observed.state === 'manifest_needs_exclusions') {
    const body = new URLSearchParams({ hash: expected.hash,
      id: observed.passive.map((file) => String(file.index)).join('|'),
      priority: '0' });
    try {
      await fetchImpl(new URL('/api/v2/torrents/filePrio', base), {
        method: 'POST', headers: { ...headers,
          'Content-Type': 'application/x-www-form-urlencoded' },
        body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
      });
    } catch { /* An uncertain response is resolved by the exact manifest below. */ }
    observed = await observeStoppedManifest({ baseUrl, sessionId, expected,
      fetchImpl, timeoutMs, expectedFiles: metainfo.files, saveRoot });
  }
  if (observed.state !== 'manifest_safe') return observed;
  const recorded = ledger.recordTorrent({ attemptId, hash: expected.hash, nowMs });
  if (recorded.state !== 'torrent_observed') return recorded;
  return { state: 'stopped_observed', attemptId, hash: expected.hash,
    videos: observed.videos, subtitles: observed.subtitles };
}
