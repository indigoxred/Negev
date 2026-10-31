import { readBoundedJson } from '../http/bounded-response.mjs';
import { evaluateStoppedManifest } from './evaluate-stopped-manifest.mjs';
import { matchesStagingSavePath } from './staging-save-path.mjs';

const held = (reason) => ({ state: 'held', reason });

// Read-only, double-observed qBittorrent manifest. It never starts a torrent.
export async function observeStoppedManifest({
  baseUrl, sessionId, expected, fetchImpl = fetch, timeoutMs = 10_000,
}) {
  let base;
  try { base = new URL(baseUrl); } catch { throw new TypeError('Invalid qBittorrent URL'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
      base.search || base.hash || base.pathname !== '/' ||
      typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(sessionId) ||
      !matchesStagingSavePath(expected) || expected.category !== 'negev' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError('Invalid stopped-manifest configuration');
  }
  const headers = { Cookie: `SID=${sessionId}`, Accept: 'application/json' };
  const read = async (endpoint, parameter, maxChars) => {
    const url = new URL(`/api/v2/torrents/${endpoint}`, base);
    url.searchParams.set(parameter, expected.hash);
    const response = await fetchImpl(url, { method: 'GET', headers, redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs) });
    if (response.status !== 200) throw new Error('qBittorrent read failed');
    return readBoundedJson(response, maxChars);
  };
  let before, after, files, filesAfter;
  try {
    const first = await read('info', 'hashes', 100_000);
    if (!Array.isArray(first) || first.length !== 1 ||
        first[0]?.hash?.toLowerCase() !== expected.hash.toLowerCase()) return held('torrent_unavailable');
    before = first[0];
    files = await read('files', 'hash', 2_000_000);
    const final = await read('info', 'hashes', 100_000);
    if (!Array.isArray(final) || final.length !== 1 ||
        final[0]?.hash?.toLowerCase() !== expected.hash.toLowerCase()) return held('torrent_changed');
    after = final[0];
    filesAfter = await read('files', 'hash', 2_000_000);
  } catch { return held('provider_unavailable'); }
  if (!Array.isArray(files) || !Array.isArray(filesAfter) ||
      files.length > 500 || filesAfter.length > 500) return held('invalid_file_manifest');
  if (before.hash !== after.hash || before.category !== after.category ||
      before.save_path !== after.save_path || before.state !== after.state ||
      before.progress !== after.progress || before.downloaded !== after.downloaded ||
      before.amount_left !== after.amount_left || before.auto_tmm !== after.auto_tmm ||
      before.force_start !== after.force_start) return held('torrent_changed');
  const fingerprint = (items) => JSON.stringify(items.map((file) => [
    file.index, file.name, file.size, file.priority, file.progress,
  ]));
  if (fingerprint(files) !== fingerprint(filesAfter)) return held('manifest_changed');
  return evaluateStoppedManifest({ torrent: after, files: filesAfter, expected });
}
