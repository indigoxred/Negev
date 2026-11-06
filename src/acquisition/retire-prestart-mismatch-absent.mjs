import path from 'node:path';
import { lstat, readdir } from 'node:fs/promises';
import { readBoundedJson } from '../http/bounded-response.mjs';
import { qbittorrentSessionCookie, validQbittorrentSessionId } from
  './qbittorrent-session-cookie.mjs';

const held = (reason) => ({ state: 'held', reason });
const hashPattern = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

// Reconcile only after a separate, exact removal of the stopped torrent.
// Both the provider record and the owned staging leaf must be absent/empty;
// the ledger then verifies its recorded mismatch and missing start intent.
export async function retirePrestartMismatchAbsent({ ledger, attemptId,
  baseUrl, sessionId, stagingRoot, verifyStagingRoot, nowMs,
  fetchImpl = fetch, timeoutMs = 10_000,
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
      /[\\\0\r\n]/.test(stagingRoot) ||
      typeof verifyStagingRoot !== 'function' ||
      typeof ledger?.getAttempt !== 'function' ||
      typeof ledger?.getStalledRetirementIntent !== 'function' ||
      typeof ledger?.retirePrestartMismatch !== 'function' ||
      typeof fetchImpl !== 'function' || typeof lstatImpl !== 'function' ||
      typeof readdirImpl !== 'function') {
    throw new TypeError('Invalid prestart mismatch reconciliation');
  }
  const attempt = ledger.getAttempt(attemptId);
  if (attempt?.status === 'retired_prestart_mismatch') {
    return { state: 'retired_prestart_mismatch' };
  }
  if (attempt?.id !== attemptId || attempt.status !== 'torrent_observed' ||
      !hashPattern.test(attempt.torrentHash) ||
      attempt.expectedHash !== attempt.torrentHash) return held('candidate_not_active');
  const hash = attempt.torrentHash;
  const intent = ledger.getStalledRetirementIntent(attemptId);
  if (intent?.hash !== hash || intent.status !== 'delete_unknown') {
    return held('retirement_not_requested');
  }
  const leaf = path.posix.join(stagingRoot, hash);
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
  const url = new URL('/api/v2/torrents/info', base);
  url.searchParams.set('hashes', hash);
  const headers = { Cookie: qbittorrentSessionCookie(sessionId),
    Accept: 'application/json' };
  for (let observation = 0; observation < 2; observation++) {
    let root;
    try { root = await verifyStagingRoot(); }
    catch { return held('staging_root_unverified'); }
    if (root?.state !== 'verified_staging_root') {
      return held('staging_root_unverified');
    }
    let torrents;
    try {
      const response = await fetchImpl(url, { method: 'GET', headers,
        redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      if (response.status !== 200) return held('provider_unavailable');
      torrents = await readBoundedJson(response, 100_000);
    } catch { return held('provider_unavailable'); }
    if (!Array.isArray(torrents) || torrents.length > 1) {
      return held('invalid_torrent_observation');
    }
    if (torrents.length !== 0) return held('torrent_still_present');
    if (!await emptyLeaf()) return held('staging_not_empty');
  }
  return ledger.retirePrestartMismatch({ attemptId, hash, nowMs });
}
