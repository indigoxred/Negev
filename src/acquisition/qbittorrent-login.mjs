import { readBoundedText } from '../http/bounded-response.mjs';
import { validQbittorrentSessionId } from './qbittorrent-session-cookie.mjs';

const held = (reason) => ({ state: 'held', reason });

// qBittorrent WebUI sessions are deliberately short lived in Negev. A failed
// login is a hold, never a retry loop that could trigger qBittorrent's IP ban.
export async function loginQbittorrent({
  baseUrl, username, password, fetchImpl = fetch, timeoutMs = 10_000,
}) {
  let base;
  try { base = new URL(baseUrl); } catch { throw new TypeError('Invalid qBittorrent URL'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
      base.search || base.hash || base.pathname !== '/' ||
      typeof username !== 'string' || !username || username.length > 256 ||
      typeof password !== 'string' || !password || password.length > 4096 ||
      typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError('Invalid qBittorrent login configuration');
  }
  const form = new URLSearchParams({ username, password });
  let response, body;
  try {
    response = await fetchImpl(new URL('/api/v2/auth/login', base), {
      method: 'POST', headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: base.href,
      },
      body: form.toString(), redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 403) return held('authentication_forbidden');
    if (response.status !== 200 && response.status !== 204) {
      return held('authentication_unavailable');
    }
    body = response.status === 204 ? '' : await readBoundedText(response, 64);
  } catch { return held('authentication_unavailable'); }
  if (response.status === 200 && body.trim() !== 'Ok.') {
    return held('authentication_failed');
  }
  const cookies = response.headers?.getSetCookie?.() ??
    [response.headers?.get?.('set-cookie')].filter(Boolean);
  const sid = cookies.flatMap((cookie) => {
    const match = /^(SID|QBT_SID_[1-9][0-9]{0,4})=([A-Za-z0-9_-]{1,256})(?:;|$)/.exec(cookie);
    if (!match) return [];
    const value = match[1] === 'SID' ? match[2] : `${match[1]}=${match[2]}`;
    return validQbittorrentSessionId(value) ? [value] : [];
  });
  if (cookies.length !== 1 || sid.length !== 1 ||
      /;\s*(?:SID|QBT_SID_[0-9]+)\s*=/i.test(cookies[0])) {
    return held('authentication_unavailable');
  }
  return { state: 'authenticated', sessionId: sid[0] };
}
