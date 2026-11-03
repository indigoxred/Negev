import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { readBoundedJson } from '../http/bounded-response.mjs';
import { qbittorrentSessionCookie, validQbittorrentSessionId } from
  './qbittorrent-session-cookie.mjs';
import { stagingSavePath, validStagingSaveRoot } from './staging-save-path.mjs';

const held = (reason) => ({ state: 'held', reason });
const validHash = (value) => typeof value === 'string' &&
  /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value);

// Called only for an operator-requested, Negev-owned incomplete torrent.
// The durable delete intent is written before the one POST. A timeout is
// unknown, never an instruction to send another delete request.
export async function deleteStalledTorrent({ ledger, attemptId, baseUrl,
  sessionId, stagingRoot, saveRoot, verifyStagingRoot, nowMs,
  fetchImpl = fetch, timeoutMs = 10_000, lstatImpl = lstat } = {}) {
  let base;
  try { base = new URL(baseUrl); } catch { throw new TypeError('Invalid qBittorrent URL'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username ||
      base.password || base.pathname !== '/' || base.search || base.hash ||
      !validQbittorrentSessionId(sessionId) ||
      !Number.isSafeInteger(attemptId) || attemptId < 1 ||
      !Number.isSafeInteger(nowMs) || nowMs < 0 ||
      typeof stagingRoot !== 'string' || !path.posix.isAbsolute(stagingRoot) ||
      stagingRoot === '/' || path.posix.normalize(stagingRoot) !== stagingRoot ||
      /[\\\0\r\n]/.test(stagingRoot) || !validStagingSaveRoot(saveRoot) ||
      typeof verifyStagingRoot !== 'function' ||
      typeof ledger?.getAttempt !== 'function' ||
      typeof ledger?.getStalledRetirementIntent !== 'function' ||
      typeof ledger?.beginStalledDelete !== 'function' ||
      typeof fetchImpl !== 'function' ||
      typeof lstatImpl !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError('Invalid stalled-torrent deletion');
  }
  const attempt = ledger.getAttempt(attemptId);
  if (attempt?.id !== attemptId || attempt.status !== 'torrent_observed' ||
      !validHash(attempt.torrentHash) ||
      attempt.expectedHash !== attempt.torrentHash) return held('candidate_not_active');
  const hash = attempt.torrentHash;
  const intent = ledger.getStalledRetirementIntent(attemptId);
  if (intent?.hash !== hash) return held('retirement_not_requested');
  if (intent.status === 'delete_unknown') {
    return { state: 'delete_unknown', sendNow: false };
  }
  if (intent.status !== 'requested') return held('retirement_conflict');
  const savePath = stagingSavePath(hash, { saveRoot });
  const headers = { Cookie: qbittorrentSessionCookie(sessionId),
    Accept: 'application/json' };
  const read = async (endpoint, parameter) => {
    const url = new URL(`/api/v2/torrents/${endpoint}`, base);
    url.searchParams.set(parameter, hash);
    const response = await fetchImpl(url, { method: 'GET', headers,
      redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    if (response.status !== 200) throw new Error('qBittorrent read failed');
    return readBoundedJson(response, 100_000);
  };
  for (let observation = 0; observation < 2; observation++) {
    let root;
    try { root = await verifyStagingRoot(); }
    catch { return held('staging_root_unverified'); }
    if (root?.state !== 'verified_staging_root') {
      return held('staging_root_unverified');
    }
    let leaf;
    try { leaf = await lstatImpl(path.posix.join(stagingRoot, hash)); }
    catch { return held('staging_leaf_unverified'); }
    if (!leaf.isDirectory() || leaf.isSymbolicLink()) {
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
        typeof torrent.progress !== 'number' || torrent.progress < 0 ||
        torrent.progress >= 1 || properties?.save_path !== savePath ||
        !['', savePath].includes(properties?.download_path)) {
      return held('torrent_ownership_changed');
    }
  }
  const send = ledger.beginStalledDelete({ attemptId, hash, nowMs });
  if (send.state !== 'delete_unknown' || !send.sendNow) return send;
  const body = new URLSearchParams({ hashes: hash, deleteFiles: 'true' });
  try {
    await fetchImpl(new URL('/api/v2/torrents/delete', base), {
      method: 'POST', headers: { Cookie: qbittorrentSessionCookie(sessionId) },
      body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
    });
  } catch { /* The delete may have reached qBittorrent. Never send again. */ }
  return { state: 'delete_unknown', sendNow: true };
}
