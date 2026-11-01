import { createQbittorrentSessionGate } from
  '../acquisition/qbittorrent-session-gate.mjs';
import { createQbittorrentSessionFetch } from
  '../acquisition/qbittorrent-session-fetch.mjs';
import { readQbittorrentSidecarTorrent } from
  '../acquisition/qbittorrent-sidecar.mjs';

// Diagnostic-only, exact-hash read. Failed authentication or a rejected SID
// yields no evidence and the caller keeps Import held.
export function createQbittorrentSidecarObserver({ baseUrl, username, password,
  login, fetchImpl = fetch, now = Date.now } = {}) {
  const gate = createQbittorrentSessionGate({ baseUrl, username, password,
    ...(login === undefined ? {} : { login }), now });
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('Invalid qBittorrent sidecar fetch');
  }
  return { async readTorrent(hash) {
    const session = await gate.get();
    if (session.state !== 'authenticated') return null;
    const sessionFetch = createQbittorrentSessionFetch({ baseUrl,
      sessionId: session.sessionId, sessionGate: gate, fetchImpl });
    return readQbittorrentSidecarTorrent({ baseUrl,
      sessionId: session.sessionId, hash, fetchImpl: sessionFetch });
  } };
}
