import { loginQbittorrent } from './qbittorrent-login.mjs';
import { validQbittorrentSessionId } from './qbittorrent-session-cookie.mjs';

const held = (reason) => ({ state: 'held', reason });
const validSid = validQbittorrentSessionId;
// Refresh before qBittorrent's default one-hour WebUI session lifetime.
// A configured shorter lifetime still follows the existing 403/backoff path.
const MAX_SESSION_AGE_MS = 30 * 60_000;

// One session for the paced acquisition runtime. A bad password or a 403
// latches until restart so worker ticks cannot trigger qBittorrent's IP ban.
// A caller must invalidate an exact SID after an authenticated API rejection.
export function createQbittorrentSessionGate({ baseUrl, username, password,
  login = loginQbittorrent, now = Date.now,
  retryDelayMs = 30 * 60_000 } = {}) {
  if (typeof baseUrl !== 'string' || !baseUrl ||
      typeof username !== 'string' || !username ||
      typeof password !== 'string' || !password ||
      typeof login !== 'function' || typeof now !== 'function' ||
      !Number.isSafeInteger(retryDelayMs) || retryDelayMs < 1_000 ||
      retryDelayMs > 86_400_000) {
    throw new TypeError('Invalid qBittorrent session gate');
  }
  let sessionId = null;
  let authenticatedAtMs = null;
  let pending;
  let rejectedReason = null;
  let retryAtMs = null;
  const clock = () => {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError('Invalid qBittorrent session clock');
    }
    return value;
  };
  const authenticate = (currentMs) => {
    if (pending) return pending;
    sessionId = null;
    authenticatedAtMs = null;
    pending = (async () => {
      let result;
      try { result = await login({ baseUrl, username, password }); }
      catch { result = held('authentication_unavailable'); }
      if (result?.state === 'authenticated' && validSid(result.sessionId)) {
        sessionId = result.sessionId;
        authenticatedAtMs = currentMs;
        retryAtMs = null;
        return { state: 'authenticated', sessionId };
      }
      if (['authentication_failed', 'authentication_forbidden']
        .includes(result?.reason)) {
        rejectedReason = result.reason;
        retryAtMs = null;
        return held(rejectedReason);
      }
      retryAtMs = currentMs + retryDelayMs;
      if (!Number.isSafeInteger(retryAtMs)) retryAtMs = Number.MAX_SAFE_INTEGER;
      return held('authentication_unavailable');
    })().finally(() => { pending = undefined; });
    return pending;
  };
  const fresh = (currentMs) => sessionId !== null &&
    authenticatedAtMs !== null && currentMs - authenticatedAtMs < MAX_SESSION_AGE_MS;
  return {
    get() {
      const currentMs = clock();
      if (rejectedReason) return Promise.resolve(held(rejectedReason));
      if (pending) return pending;
      if (fresh(currentMs)) return Promise.resolve({ state: 'authenticated', sessionId });
      if (retryAtMs !== null && currentMs < retryAtMs) {
        return Promise.resolve(held('authentication_backoff'));
      }
      return authenticate(currentMs);
    },
    renew(expectedSessionId) {
      if (!validSid(expectedSessionId)) {
        return Promise.resolve(held('session_mismatch'));
      }
      const currentMs = clock();
      if (rejectedReason) return Promise.resolve(held(rejectedReason));
      if (pending) return pending;
      if (sessionId !== expectedSessionId) {
        return fresh(currentMs)
          ? Promise.resolve({ state: 'authenticated', sessionId })
          : sessionId ? authenticate(currentMs)
            : Promise.resolve(held('authentication_backoff'));
      }
      return authenticate(currentMs);
    },
    invalidate(expectedSessionId) {
      if (!validSid(expectedSessionId) || expectedSessionId !== sessionId) {
        return held('session_mismatch');
      }
      sessionId = null;
      authenticatedAtMs = null;
      retryAtMs = clock() + retryDelayMs;
      if (!Number.isSafeInteger(retryAtMs)) retryAtMs = Number.MAX_SAFE_INTEGER;
      return { state: 'invalidated' };
    },
    getStatus() {
      return { state: rejectedReason ? 'credentials_rejected' :
        sessionId ? 'authenticated' : pending ? 'authenticating' :
        retryAtMs === null ? 'not_started' : 'waiting', retryAtMs };
    },
  };
}
