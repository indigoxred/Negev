// Keep qBittorrent's SID on its own API origin, and invalidate that exact
// session on 403. This wrapper does not retry an uncertain request or perform
// login; the paced session gate controls the next authentication attempt.
export function createQbittorrentSessionFetch({ baseUrl, sessionId,
  sessionGate, fetchImpl = fetch } = {}) {
  let base;
  try { base = new URL(baseUrl); } catch { throw new TypeError('Invalid qBittorrent URL'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username ||
      base.password || base.pathname !== '/' || base.search || base.hash ||
      typeof sessionId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,256}$/.test(sessionId) ||
      typeof sessionGate?.invalidate !== 'function' ||
      typeof fetchImpl !== 'function') {
    throw new TypeError('Invalid qBittorrent session fetch');
  }
  return async (input, init = {}) => {
    let target;
    try { target = new URL(input); }
    catch { throw new TypeError('Invalid provider URL'); }
    const cookie = new Headers(init.headers).get('cookie');
    const usesSession = cookie === `SID=${sessionId}`;
    if (usesSession && (target.origin !== base.origin ||
        !target.pathname.startsWith('/api/v2/'))) {
      throw new TypeError('qBittorrent SID outside its API');
    }
    const response = await fetchImpl(input, init);
    if (usesSession && response.status === 403) {
      sessionGate.invalidate(sessionId);
    }
    return response;
  };
}
