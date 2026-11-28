import { cancelResponseBody, readBoundedJson, readBoundedText } from '../http/bounded-response.mjs';
import { MAX_TORRENT_METAINFO_BYTES } from './torrent-metainfo-limits.mjs';
import { inspectTorrentMetainfo } from './inspect-torrent-metainfo.mjs';
import { observeStoppedManifest } from './observe-stopped-manifest.mjs';
import { torrentFileKind } from './evaluate-stopped-manifest.mjs';
import { evaluateStagingMountIsolation } from './staging-mount-isolation.mjs';
import { matchesStagingSavePath } from './staging-save-path.mjs';
import { acquireAttemptOperation } from './attempt-operation-ownership.mjs';
import { checkAcquisitionAccess } from './acquisition-access.mjs';
import { qbittorrentSessionCookie, validQbittorrentSessionId } from
  './qbittorrent-session-cookie.mjs';

import { heldReporter } from '../runtime/held-diagnostics.mjs';
const held = (reason) => ({ state: 'held', reason });
const heldAfter = heldReporter('acquisition/submit-stopped-candidate');
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
  if (!(torrent instanceof Blob) || torrent.size < 1 || torrent.size > MAX_TORRENT_METAINFO_BYTES) return null;
  const metainfo = inspectTorrentMetainfo({ bytes: new Uint8Array(await torrent.arrayBuffer()) });
  return metainfo.state === 'metainfo_checked' &&
    metainfo.hash === prepared.expected.hash.toLowerCase() ? metainfo : null;
}

// Server-only one-send boundary. Fresh local staging evidence is required
// before each write. An uncertain POST is reconciled by exact stopped
// observation, never retried.
export async function submitStoppedCandidate(input) {
  const release = acquireAttemptOperation(input?.ledger, input?.attemptId);
  if (!release) return held('submission_in_progress');
  try { return await submitOwnedCandidate(input); }
  finally { release(); }
}

async function submitOwnedCandidate({
  ledger, attemptId, candidate, prepared, hostPath, inspectMounts, realpathImpl, authorizeRequest,
  verifyStagingRoot, saveRoot, plannedFileNames, excludedFileNames,
  baseUrl, sessionId, nowMs, now = () => nowMs, fetchImpl = fetch, timeoutMs = 10_000,
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
      typeof now !== 'function' || typeof fetchImpl !== 'function' || !ledger ||
      typeof ledger.bindPreparedTorrent !== 'function' ||
      typeof ledger.beginDispatch !== 'function' ||
      typeof ledger.recordTorrent !== 'function') {
    throw new TypeError('Invalid stopped submission configuration');
  }
  const metainfo = await exactPreparedTorrent(prepared, saveRoot);
  if (!metainfo) return held('prepared_torrent_mismatch');
  if (metainfo.files.some(file => !['video', 'subtitle', 'passive'].includes(torrentFileKind(file.name)))) {
    return held('unsafe_file');
  }
  const checkMounts = async () => {
    if (verifyStagingRoot) {
      try {
        const result = await verifyStagingRoot();
        return result?.state === 'verified_staging_root'
          ? { state: 'isolated_mount' } : held('staging_root_unverified');
      } catch (error) { return heldAfter(error, 'staging_root_unverified'); }
    }
    let mounts, realPath;
    try {
      mounts = await inspectMounts();
      realPath = await realpathImpl(hostPath);
    } catch (error) { return heldAfter(error, 'mount_evidence_unavailable'); }
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
  if (typeof ledger.recordTorrentSelection === 'function') {
    const saved = ledger.recordTorrentSelection({ attemptId, hash: expected.hash,
      files: metainfo.files, excludedFileNames, nowMs });
    if (saved.state !== 'selection_recorded') return saved;
    if(saved.excludedFileNames)excludedFileNames=saved.excludedFileNames;
  } else if (excludedFileNames?.length) return held('selection_journal_unavailable');

  const headers = { Cookie: qbittorrentSessionCookie(sessionId) };
  if (bound.state === 'prepared') {
    const access = await checkAcquisitionAccess(authorizeRequest, { attemptId });
    if (access.state === 'held') return access;

    let version;
    try {
      const response = await fetchImpl(new URL('/api/v2/app/version', base), {
        method: 'GET', headers, redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status !== 200) await cancelResponseBody(response);
      if (response.status !== 200) return held('provider_unavailable');
      version = (await readBoundedText(response, 32)).trim();
    } catch (error) { return heldAfter(error, 'provider_unavailable'); }
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
      if (response.status !== 200) await cancelResponseBody(response);
      if (response.status !== 200) return held('provider_unavailable');
      existing = await readBoundedJson(response, 100_000);
    } catch (error) { return heldAfter(error, 'provider_unavailable'); }
    if (!Array.isArray(existing)) return held('provider_unavailable');
    if (existing.length !== 0) return held('torrent_hash_in_use');
    const isolation = await checkMounts();
    if (isolation.state !== 'isolated_mount') return isolation;
    const intent = ledger.beginDispatch({ attemptId, nowMs, restricted: access.restricted });
    if (intent.state === 'held') return intent;
    if (intent.sendNow) {
      addAttempted = true;
      try {
        const receipt = await fetchImpl(new URL('/api/v2/torrents/add', base), {
          method: 'POST', headers, body: prepared.form, redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        });
        if(receipt.status===403 && typeof ledger.rejectDispatch==='function') {
          let refused;
          try{refused=ledger.rejectDispatch({attemptId,candidate,hash:expected.hash,nowMs:now(),httpStatus:403});}
          finally{await cancelResponseBody(receipt);}
          if(refused?.state==='dispatch_rejected')return held('provider_http_403');
          return refused??held('dispatch_refusal_unreconciled');
        }
        await cancelResponseBody(receipt);
      } catch { /* Response is uncertain; observe by exact hash below. */ }
    }
  }

  if (bound.state !== 'prepared') {
    const isolation = await checkMounts();
    if (isolation.state !== 'isolated_mount') return isolation;
  }

  let observed = await observeStoppedManifest({ baseUrl, sessionId, expected,
    fetchImpl, timeoutMs, allowSelectedPassive: true,
    plannedFileNames, excludedFileNames, expectedFiles: metainfo.files, saveRoot });
  // qBittorrent may acknowledge an add before its torrent list exposes the
  // hash or while it briefly checks the new torrent. Re-read the full exact
  // manifest for up to five seconds; never send another add or accept a
  // non-pristine result. qBittorrent may take longer than the original 1.25
  // seconds to finish its initial metadata check even with zero bytes saved.
  for (let retry = 0; addAttempted &&
      ['torrent_unavailable', 'not_pristine_stopped'].includes(observed.reason) &&
      retry < 20; retry++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    observed = await observeStoppedManifest({ baseUrl, sessionId, expected,
      fetchImpl, timeoutMs, allowSelectedPassive: true,
      plannedFileNames, excludedFileNames, expectedFiles: metainfo.files, saveRoot });
  }
  if (observed.state === 'manifest_needs_exclusions') {
    const isolation = await checkMounts();
    if (isolation.state !== 'isolated_mount') return isolation;
    const access = await checkAcquisitionAccess(authorizeRequest, { attemptId });
    if (access.state === 'held') return access;
    const body = new URLSearchParams({ hash: expected.hash,
      id: observed.passive.map((file) => String(file.index)).join('|'),
      priority: '0' });
    try {
      const receipt = await fetchImpl(new URL('/api/v2/torrents/filePrio', base), {
        method: 'POST', headers: { ...headers,
          'Content-Type': 'application/x-www-form-urlencoded' },
        body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
      });
      await cancelResponseBody(receipt);
    } catch { /* An uncertain response is resolved by the exact manifest below. */ }
    observed = await observeStoppedManifest({ baseUrl, sessionId, expected,
      fetchImpl, timeoutMs, plannedFileNames, excludedFileNames, expectedFiles: metainfo.files, saveRoot });
  }
  if (observed.state !== 'manifest_safe') return observed;
  const recorded = ledger.recordTorrent({ attemptId, hash: expected.hash, nowMs });
  if (recorded.state !== 'torrent_observed') return recorded;
  return { state: 'stopped_observed', attemptId, hash: expected.hash,
    videos: observed.videos, subtitles: observed.subtitles };
}
