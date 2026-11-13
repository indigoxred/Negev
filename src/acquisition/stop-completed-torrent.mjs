import { qbittorrentSessionCookie, validQbittorrentSessionId } from
  './qbittorrent-session-cookie.mjs';
import { observeTorrentCompletion } from './qbittorrent-observation.mjs';

const held = (reason) => ({ state: 'held', reason });

// The downloaded torrent remains owned by qBittorrent until this confirms it
// has stopped. An uncertain stop response never authorizes a move: the next
// tick re-observes the exact saved hash before doing anything else.
export async function stopCompletedTorrent({ baseUrl, sessionId, expected,
  fetchImpl = fetch, observe = observeTorrentCompletion } = {}) {
  let base;
  try { base = new URL(baseUrl); } catch { throw new TypeError('Invalid qBittorrent URL'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
      base.pathname !== '/' || base.search || base.hash ||
      !validQbittorrentSessionId(sessionId) ||
      !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(expected?.hash) ||
      expected?.category !== 'negev' ||
      typeof expected.savePath !== 'string' || !expected.savePath.startsWith('/') ||
      typeof fetchImpl !== 'function' || typeof observe !== 'function') {
    throw new TypeError('Invalid qBittorrent stop configuration');
  }
  const input = { baseUrl, sessionId, expected, fetchImpl };
  let before;
  try { before = await observe(input); }
  catch { return held('torrent_unavailable'); }
  if (before?.state !== 'complete') return before ?? held('torrent_unavailable');
  const body = new URLSearchParams({ hashes: expected.hash });
  let response;
  try {
    response = await fetchImpl(new URL('/api/v2/torrents/stop', base), {
      method: 'POST', headers: { Cookie: qbittorrentSessionCookie(sessionId),
        'Content-Type': 'application/x-www-form-urlencoded' },
      body, redirect: 'manual', signal: AbortSignal.timeout(10_000),
    });
  } catch { return held('stop_outcome_unknown'); }
  if (response.status !== 200) return held(response.status === 403
    ? 'provider_http_403' : 'stop_outcome_unknown');
  let after;
  try { after = await observe({ ...input, requireStopped: true }); }
  catch { return held('torrent_unavailable_after_stop'); }
  // qBittorrent can acknowledge stop before its state changes to stoppedUP.
  // Re-read the exact hash briefly; never send another stop or relax the manifest check.
  for (let retry = 0; retry < 2 && after?.state === 'held' &&
      after.reason === 'torrent_not_stopped'; retry++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    try { after = await observe({ ...input, requireStopped: true }); }
    catch { return held('torrent_unavailable_after_stop'); }
  }
  if (after?.state !== 'complete') return after ?? held('torrent_unavailable_after_stop');
  const fingerprint = (value) => JSON.stringify({ files: value.files,
    subtitles: value.subtitles ?? [] });
  return fingerprint(before) === fingerprint(after)
    ? after : held('manifest_changed_after_stop');
}
