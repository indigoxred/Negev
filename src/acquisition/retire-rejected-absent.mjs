import { readBoundedJson } from '../http/bounded-response.mjs';
import { qbittorrentSessionCookie, validQbittorrentSessionId } from
  './qbittorrent-session-cookie.mjs';

const held = (reason) => ({ state: 'held', reason });

// Read-only reconciliation after an operator or separate reviewed action has
// removed a wrong-identity torrent without deleting its staged files. Never
// treat an HTTP error, malformed response, or one empty read as absence.
export async function retireRejectedAbsent({ ledger, attemptId, baseUrl, sessionId,
  nowMs, fetchImpl = fetch, timeoutMs = 10_000 }) {
  let base;
  try { base = new URL(baseUrl); } catch { throw new TypeError('Invalid qBittorrent URL'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
      base.pathname !== '/' || base.search || base.hash ||
      !validQbittorrentSessionId(sessionId) ||
      !Number.isSafeInteger(attemptId) || attemptId < 1 ||
      !Number.isSafeInteger(nowMs) || nowMs < 0 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 ||
      typeof ledger?.getAttempt !== 'function' ||
      typeof ledger?.retireRejected !== 'function' || typeof fetchImpl !== 'function') {
    throw new TypeError('Invalid rejected-torrent reconciliation');
  }
  const attempt = ledger.getAttempt(attemptId);
  if (attempt?.status === 'retired_rejected') return { state: 'retired_rejected' };
  if (attempt?.status !== 'rejected_held' ||
      attempt.rejectionReason !== 'file_wrong_identity') return held('candidate_not_rejected');
  const hash = attempt.torrentHash;
  if (typeof hash !== 'string' ||
      !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(hash) ||
      attempt.expectedHash !== hash) return held('torrent_conflict');

  const url = new URL('/api/v2/torrents/info', base);
  url.searchParams.set('hashes', hash);
  const headers = { Cookie: qbittorrentSessionCookie(sessionId),
    Accept: 'application/json' };
  for (let observation = 0; observation < 2; observation++) {
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
  }
  return ledger.retireRejected({ attemptId, hash, nowMs });
}
