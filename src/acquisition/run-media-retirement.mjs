import path from 'node:path';
import { lstat, readdir } from 'node:fs/promises';
import { readBoundedJson } from '../http/bounded-response.mjs';
import { qbittorrentSessionCookie, validQbittorrentSessionId } from
  './qbittorrent-session-cookie.mjs';
import { stagingSavePath, validStagingSaveRoot } from './staging-save-path.mjs';

const held = (reason) => ({ state: 'held', reason });
const validHash = (value) => typeof value === 'string' &&
  /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value);

// The media verdict is durable before this runs. Delete only one exact,
// completed, stopped Negev torrent and its owned staging leaf. A timed-out
// delete is never resent; subsequent calls only reconcile absence.
export async function runMediaRetirement({ ledger, attemptId, baseUrl,
  sessionId, stagingRoot, saveRoot, verifyStagingRoot, nowMs,
  fetchImpl = fetch, renewQbittorrent, timeoutMs = 10_000,
  lstatImpl = lstat, readdirImpl = readdir } = {}) {
  let base;
  try { base = new URL(baseUrl); } catch { throw new TypeError('Invalid qBittorrent URL'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username ||
      base.password || base.pathname !== '/' || base.search || base.hash ||
      !validQbittorrentSessionId(sessionId) ||
      !Number.isSafeInteger(attemptId) || attemptId < 1 ||
      !Number.isSafeInteger(nowMs) || nowMs < 0 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 ||
      typeof stagingRoot !== 'string' || !path.posix.isAbsolute(stagingRoot) ||
      stagingRoot === '/' || path.posix.normalize(stagingRoot) !== stagingRoot ||
      /[\\\0\r\n]/.test(stagingRoot) || !validStagingSaveRoot(saveRoot) ||
      typeof verifyStagingRoot !== 'function' ||
      typeof ledger?.getAttempt !== 'function' ||
      typeof ledger?.getMediaRetirementIntent !== 'function' ||
      typeof ledger?.beginMediaDelete !== 'function' ||
      typeof ledger?.resetMediaDeleteAfterRejection !== 'function' ||
      typeof ledger?.retireMedia !== 'function' ||
      typeof fetchImpl !== 'function' || typeof lstatImpl !== 'function' ||
      typeof readdirImpl !== 'function' ||
      (renewQbittorrent !== undefined &&
        typeof renewQbittorrent !== 'function')) {
    throw new TypeError('Invalid media retirement operation');
  }
  const attempt = ledger.getAttempt(attemptId);
  if (attempt?.status === 'retired_media') return { state: 'retired_media' };
  if (attempt?.id !== attemptId || attempt.status !== 'torrent_observed' ||
      !validHash(attempt.torrentHash) ||
      attempt.expectedHash !== attempt.torrentHash) {
    return held('candidate_not_active');
  }
  const hash = attempt.torrentHash;
  const intent = ledger.getMediaRetirementIntent(attemptId);
  if (intent?.hash !== hash) return held('retirement_not_requested');
  const leaf = path.posix.join(stagingRoot, hash);
  const savePath = stagingSavePath(hash, { saveRoot });
  let activeSessionId = sessionId;
  let activeFetch = fetchImpl;
  let renewed = false;
  const read = async (endpoint, parameter) => {
    const url = new URL(`/api/v2/torrents/${endpoint}`, base);
    url.searchParams.set(parameter, hash);
    let response = await activeFetch(url, { method: 'GET',
      headers: { Cookie: qbittorrentSessionCookie(activeSessionId),
        Accept: 'application/json' },
      redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    if (response.status === 403 && renewQbittorrent && !renewed) {
      renewed = true;
      const replacement = await renewQbittorrent(activeSessionId);
      if (replacement?.state !== 'authenticated' ||
          !validQbittorrentSessionId(replacement.sessionId) ||
          typeof replacement.fetchImpl !== 'function') {
        throw Error('qBittorrent renewal failed');
      }
      activeSessionId = replacement.sessionId;
      activeFetch = replacement.fetchImpl;
      response = await activeFetch(url, { method: 'GET',
        headers: { Cookie: qbittorrentSessionCookie(activeSessionId),
          Accept: 'application/json' },
        redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    }
    if (response.status !== 200) throw Error('qBittorrent read failed');
    return readBoundedJson(response, 100_000);
  };
  const verifiedRoot = async () => {
    try { return (await verifyStagingRoot())?.state === 'verified_staging_root'; }
    catch { return false; }
  };
  const emptyLeaf = async () => {
    let before;
    try { before = await lstatImpl(leaf, { bigint: true }); }
    catch (error) { return error?.code === 'ENOENT'; }
    if (!before.isDirectory() || before.isSymbolicLink()) return false;
    try {
      const entries = await readdirImpl(leaf);
      const after = await lstatImpl(leaf, { bigint: true });
      return entries.length === 0 && after.isDirectory() &&
        !after.isSymbolicLink() && before.dev === after.dev &&
        before.ino === after.ino && before.mtimeNs === after.mtimeNs;
    } catch { return false; }
  };
  if (intent.status === 'requested') {
    for (let observation = 0; observation < 2; observation++) {
      if (!await verifiedRoot()) return held('staging_root_unverified');
      let leafStat;
      try { leafStat = await lstatImpl(leaf); }
      catch { return held('staging_leaf_unverified'); }
      if (!leafStat.isDirectory() || leafStat.isSymbolicLink()) {
        return held('staging_leaf_unverified');
      }
      let torrents, properties;
      try {
        torrents = await read('info', 'hashes');
        properties = await read('properties', 'hash');
      } catch { return held('provider_unavailable'); }
      if (!Array.isArray(torrents) || torrents.length !== 1 ||
          torrents[0]?.hash?.toLowerCase() !== hash) {
        return held('torrent_unavailable');
      }
      const torrent = torrents[0];
      const contentPath = torrent.content_path;
      if (torrent.category !== 'negev' || torrent.save_path !== savePath ||
          typeof contentPath !== 'string' ||
          (contentPath !== savePath && !contentPath.startsWith(`${savePath}/`)) ||
          path.posix.normalize(contentPath) !== contentPath ||
          /[\\\0\r\n]/.test(contentPath) ||
          torrent.auto_tmm !== false || torrent.force_start !== false ||
          torrent.state !== 'stoppedUP' || torrent.progress !== 1 ||
          properties?.save_path !== savePath ||
          !['', savePath].includes(properties?.download_path)) {
        return held('torrent_ownership_changed');
      }
    }
    const send = ledger.beginMediaDelete({ attemptId, hash, nowMs });
    if (send.state !== 'delete_unknown' || !send.sendNow) return send;
    try {
      const response = await activeFetch(new URL('/api/v2/torrents/delete', base), {
        method: 'POST', headers: { Cookie: qbittorrentSessionCookie(activeSessionId) },
        body: new URLSearchParams({ hashes: hash, deleteFiles: 'true' }),
        redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 403) {
        const reset = ledger.resetMediaDeleteAfterRejection({
          attemptId, hash, nowMs });
        return reset?.state === 'retirement_requested' ?
          held('provider_http_403') : held('media_retirement_unavailable');
      }
    } catch { /* The delete may have reached qBittorrent. Never send twice. */ }
  } else if (intent.status !== 'delete_unknown') {
    return held('retirement_conflict');
  }
  for (let observation = 0; observation < 2; observation++) {
    if (!await verifiedRoot()) return held('staging_root_unverified');
    let torrents;
    try { torrents = await read('info', 'hashes'); }
    catch { return held('provider_unavailable'); }
    if (!Array.isArray(torrents) || torrents.length > 1) {
      return held('invalid_torrent_observation');
    }
    if (torrents.length !== 0) return held('torrent_still_present');
    if (!await emptyLeaf()) return held('staging_not_empty');
  }
  return ledger.retireMedia({ attemptId, hash, nowMs });
}
