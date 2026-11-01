import { readBoundedJson } from '../http/bounded-response.mjs';
import { qbittorrentSessionCookie, validQbittorrentSessionId } from
  './qbittorrent-session-cookie.mjs';

// Read-only exact-hash observation for a qBittorrent .parts sidecar. The
// caller must separately validate inactivity, age, save path and folder
// fingerprint at both ends of an Import quiet window.
export async function readQbittorrentSidecarTorrent({ baseUrl, sessionId,
  hash, fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  let base;
  try { base = new URL(baseUrl); } catch { throw new TypeError('Invalid qBittorrent URL'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username ||
      base.password || base.pathname !== '/' || base.search || base.hash ||
      !validQbittorrentSessionId(sessionId) ||
      typeof hash !== 'string' ||
      !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(hash) ||
      typeof fetchImpl !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError('Invalid qBittorrent sidecar observation');
  }
  const url = new URL('/api/v2/torrents/info', base);
  url.searchParams.set('hashes', hash.toLowerCase());
  try {
    const response = await fetchImpl(url, { method: 'GET',
      headers: { Cookie: qbittorrentSessionCookie(sessionId),
        Accept: 'application/json' },
      redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    if (response.status !== 200) return null;
    const torrents = await readBoundedJson(response, 100_000);
    return Array.isArray(torrents) && torrents.length === 1 &&
      typeof torrents[0]?.hash === 'string' &&
      torrents[0].hash.toLowerCase() === hash.toLowerCase()
      ? torrents[0] : null;
  } catch { return null; }
}
