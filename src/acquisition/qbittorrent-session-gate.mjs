import { loginQbittorrent } from './qbittorrent-login.mjs';

const held = (reason) => ({ state: 'held', reason });
const validSid = (value) => typeof value === 'string' &&
  /^[A-Za-z0-9_-]{1,256}$/.test(value);

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
  return {
    get() {
      const currentMs = clock();
      if (rejectedReason) return Promise.resolve(held(rejectedReason));
      if (sessionId) return Promise.resolve({ state: 'authenticated', sessionId });
      if (pending) return pending;
      if (retryAtMs !== null && currentMs < retryAtMs) {
        return Promise.resolve(held('authentication_backoff'));
      }
      pending = (async () => {
        let result;
        try { result = await login({ baseUrl, username, password }); }
        catch { result = held('authentication_unavailable'); }
        if (result?.state === 'authenticated' && validSid(result.sessionId)) {
          sessionId = result.sessionId;
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
    },
    invalidate(expectedSessionId) {
      if (!validSid(expectedSessionId) || expectedSessionId !== sessionId) {
        return held('session_mismatch');
      }
      sessionId = null;
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
