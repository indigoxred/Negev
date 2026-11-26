import { cancelResponseBody, readBoundedJson } from '../http/bounded-response.mjs';
import { qbittorrentSessionCookie, validQbittorrentSessionId } from
  './qbittorrent-session-cookie.mjs';
import { stagingSavePath } from './staging-save-path.mjs';

// Read-only check immediately before preserving a failed Shoko import.
export async function readStoppedRecoveryTorrent({ baseUrl, sessionId,
  hash, saveRoot, fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  let base, expectedPath;
  try {
    base = new URL(baseUrl);
    expectedPath = stagingSavePath(hash, { saveRoot });
  } catch { throw new TypeError('Invalid recovery torrent'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username ||
      base.password || base.pathname !== '/' || base.search || base.hash ||
      !validQbittorrentSessionId(sessionId) ||
      typeof fetchImpl !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
      timeoutMs > 60_000) throw new TypeError('Invalid recovery torrent');
  try {
    const url = new URL('/api/v2/torrents/info', base);
    url.searchParams.set('hashes', hash);
    const response = await fetchImpl(url, { method: 'GET',
      headers: { Cookie: qbittorrentSessionCookie(sessionId),
        Accept: 'application/json' },
      redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    if (response.status !== 200) await cancelResponseBody(response);
    if (response.status !== 200) return { state: 'unavailable' };
    const items = await readBoundedJson(response, 100_000);
    if (!Array.isArray(items) || items.length !== 1) {
      return { state: 'unavailable' };
    }
    const item = items[0];
    if (item?.hash !== hash || item.category !== 'negev' ||
        item.save_path !== expectedPath || item.auto_tmm !== false ||
        item.force_start !== false || item.progress !== 1) {
      return { state: 'unavailable' };
    }
    return ['stoppedUP', 'pausedUP', 'missingFiles'].includes(item.state)
      ? { state: 'stopped' } : { state: 'active' };
  } catch { return { state: 'unavailable' }; }
}
