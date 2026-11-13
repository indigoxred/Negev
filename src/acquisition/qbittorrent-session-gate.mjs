import { loginQbittorrent } from './qbittorrent-login.mjs';
import { validQbittorrentSessionId } from './qbittorrent-session-cookie.mjs';

const held = (reason) => ({ state: 'held', reason });
const validSid = validQbittorrentSessionId;
// Refresh before the short effective lifetime observed through the installed
// WebUI, even when its advertised timeout is longer.
const MAX_SESSION_AGE_MS = 60_000;
const REPEATED_REJECTION_WINDOW_MS = 60_000;

// One session for the paced acquisition runtime. A bad password latches until
// restart so worker ticks cannot trigger qBittorrent's IP ban. A rejected SID
// is different: it needs one immediate, shared re-login with known credentials.
// A caller must invalidate an exact SID after an authenticated API rejection.
export function createQbittorrentSessionGate({ baseUrl, username, password,
  login = loginQbittorrent, now = Date.now,
  retryDelayMs = 30_000 } = {}) {
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
  let lastInvalidatedAtMs = null;
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
      if (retryAtMs !== null && currentMs < retryAtMs) {
        return Promise.resolve(held('authentication_backoff'));
      }
      if (sessionId !== expectedSessionId) {
        return fresh(currentMs)
          ? Promise.resolve({ state: 'authenticated', sessionId })
          : authenticate(currentMs);
      }
      return authenticate(currentMs);
    },
    invalidate(expectedSessionId) {
      if (!validSid(expectedSessionId) || expectedSessionId !== sessionId) {
        return held('session_mismatch');
      }
      sessionId = null;
      authenticatedAtMs = null;
      const currentMs = clock();
      retryAtMs = lastInvalidatedAtMs !== null &&
        currentMs - lastInvalidatedAtMs < REPEATED_REJECTION_WINDOW_MS
        ? Math.min(currentMs + retryDelayMs, Number.MAX_SAFE_INTEGER) : null;
      lastInvalidatedAtMs = currentMs;
      return { state: 'invalidated' };
    },
    getStatus() {
      return { state: rejectedReason ? 'credentials_rejected' :
        sessionId ? 'authenticated' : pending ? 'authenticating' :
        retryAtMs === null ? 'not_started' : 'waiting', retryAtMs };
    },
  };
}
