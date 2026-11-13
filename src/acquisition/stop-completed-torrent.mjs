import { qbittorrentSessionCookie, validQbittorrentSessionId } from
  './qbittorrent-session-cookie.mjs';
import { observeTorrentCompletion } from './qbittorrent-observation.mjs';

const held = (reason) => ({ state: 'held', reason });

// The downloaded torrent remains owned by qBittorrent until this confirms it
// has stopped. An uncertain stop response never authorizes a move: the next
// tick re-observes the exact saved hash before doing anything else.
export async function stopCompletedTorrent({ baseUrl, sessionId, expected,
  fetchImpl = fetch, observe = observeTorrentCompletion,
  renewQbittorrent } = {}) {
  let base;
  try { base = new URL(baseUrl); } catch { throw new TypeError('Invalid qBittorrent URL'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
      base.pathname !== '/' || base.search || base.hash ||
      !validQbittorrentSessionId(sessionId) ||
      !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(expected?.hash) ||
      expected?.category !== 'negev' ||
      typeof expected.savePath !== 'string' || !expected.savePath.startsWith('/') ||
      typeof fetchImpl !== 'function' || typeof observe !== 'function' ||
      (renewQbittorrent !== undefined && typeof renewQbittorrent !== 'function')) {
    throw new TypeError('Invalid qBittorrent stop configuration');
  }
  let activeSessionId = sessionId;
  let activeFetch = fetchImpl;
  let renewedOnce = false;
  const input = () => ({ baseUrl, sessionId: activeSessionId,
    expected, fetchImpl: activeFetch });
  const renewSession = async () => {
    if (!renewQbittorrent || renewedOnce) return held('provider_http_403');
    renewedOnce = true;
    let renewed;
    try { renewed = await renewQbittorrent(activeSessionId); }
    catch { return held('authentication_unavailable'); }
    if (renewed?.state !== 'authenticated') return held(
      typeof renewed?.reason === 'string' ? renewed.reason : 'authentication_unavailable');
    if (!validQbittorrentSessionId(renewed.sessionId) ||
        typeof renewed.fetchImpl !== 'function') return held('authentication_unavailable');
    activeSessionId = renewed.sessionId;
    activeFetch = renewed.fetchImpl;
    return { state: 'authenticated' };
  };
  let before;
  try { before = await observe(input()); }
  catch { return held('torrent_unavailable'); }
  if (before?.reason === 'provider_http_403') {
    const renewed = await renewSession();
    if (renewed.state !== 'authenticated') return renewed;
    try { before = await observe(input()); }
    catch { return held('torrent_unavailable'); }
  }
  if (before?.state !== 'complete') return before ?? held('torrent_unavailable');
  const body = new URLSearchParams({ hashes: expected.hash });
  let response;
  try {
    response = await activeFetch(new URL('/api/v2/torrents/stop', base), {
      method: 'POST', headers: { Cookie: qbittorrentSessionCookie(activeSessionId),
        'Content-Type': 'application/x-www-form-urlencoded' },
      body, redirect: 'manual', signal: AbortSignal.timeout(10_000),
    });
  } catch { return held('stop_outcome_unknown'); }
  if (response.status !== 200) return held(response.status === 403
    ? 'provider_http_403' : 'stop_outcome_unknown');
  let after;
  try { after = await observe({ ...input(), requireStopped: true }); }
  catch { return held('torrent_unavailable_after_stop'); }
  if (after?.reason === 'provider_http_403') {
    const renewed = await renewSession();
    if (renewed.state !== 'authenticated') return renewed;
    try { after = await observe({ ...input(), requireStopped: true }); }
    catch { return held('torrent_unavailable_after_stop'); }
  }
  // qBittorrent can acknowledge stop before its state changes to stoppedUP.
  // Re-read the exact hash briefly; never send another stop or relax the manifest check.
  for (let retry = 0; retry < 20 && after?.state === 'held' &&
      after.reason === 'torrent_not_stopped'; retry++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    try { after = await observe({ ...input(), requireStopped: true }); }
    catch { return held('torrent_unavailable_after_stop'); }
  }
  if (after?.state !== 'complete') return after ?? held('torrent_unavailable_after_stop');
  const fingerprint = (value) => JSON.stringify({ files: value.files,
    subtitles: value.subtitles ?? [] });
  return fingerprint(before) === fingerprint(after)
    ? after : held('manifest_changed_after_stop');
}
