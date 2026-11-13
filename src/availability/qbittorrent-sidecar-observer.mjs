import { createQbittorrentSessionGate } from
  '../acquisition/qbittorrent-session-gate.mjs';
import { createQbittorrentSessionFetch } from
  '../acquisition/qbittorrent-session-fetch.mjs';
import { readQbittorrentSidecarTorrent } from
  '../acquisition/qbittorrent-sidecar.mjs';

// Diagnostic-only, exact-hash read. Failed authentication or a rejected SID
// yields no evidence and the caller keeps Import held.
export function createQbittorrentSidecarObserver({ baseUrl, username, password,
  login, sessionGate, fetchImpl = fetch, now = Date.now } = {}) {
  if (typeof fetchImpl !== 'function' ||
      (sessionGate !== undefined &&
        (typeof sessionGate?.get !== 'function' ||
         typeof sessionGate.invalidate !== 'function' ||
         username !== undefined || password !== undefined ||
         login !== undefined))) {
    throw new TypeError('Invalid qBittorrent sidecar fetch');
  }
  const gate = sessionGate ?? createQbittorrentSessionGate({
    baseUrl, username, password,
    ...(login === undefined ? {} : { login }), now });
  return { async readTorrent(hash) {
    if (typeof hash !== 'string' ||
        !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(hash)) return null;
    const session = await gate.get();
    if (session.state !== 'authenticated') return null;
    const sessionFetch = createQbittorrentSessionFetch({ baseUrl,
      sessionId: session.sessionId, sessionGate: gate, fetchImpl });
    const first = await readQbittorrentSidecarTorrent({ baseUrl,
      sessionId: session.sessionId, hash, fetchImpl: sessionFetch });
    if (first !== null) return first;
    // A 403 invalidates the shared session. One new authenticated GET is safe
    // for this read-only lookup; the gate enforces its repeated-403 backoff.
    if (!['not_started', 'waiting'].includes(gate.getStatus?.().state)) {
      return null;
    }
    const replacement = await gate.get();
    if (replacement.state !== 'authenticated') return null;
    const replacementFetch = createQbittorrentSessionFetch({ baseUrl,
      sessionId: replacement.sessionId, sessionGate: gate, fetchImpl });
    return readQbittorrentSidecarTorrent({ baseUrl,
      sessionId: replacement.sessionId, hash, fetchImpl: replacementFetch });
  } };
}
