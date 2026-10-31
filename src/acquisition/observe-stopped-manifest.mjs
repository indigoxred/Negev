import { readBoundedJson } from '../http/bounded-response.mjs';
import { evaluateStoppedManifest } from './evaluate-stopped-manifest.mjs';
import { matchesStagingSavePath } from './staging-save-path.mjs';

const held = (reason) => ({ state: 'held', reason });

// Read-only, double-observed qBittorrent manifest. It never starts a torrent.
export async function observeStoppedManifest({
  baseUrl, sessionId, expected, fetchImpl = fetch, timeoutMs = 10_000,
  allowSelectedPassive = false, expectedFiles,
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
  let before, after, beforePaths, afterPaths, files, filesAfter;
  try {
    const first = await read('info', 'hashes', 100_000);
    if (!Array.isArray(first) || first.length !== 1 ||
        first[0]?.hash?.toLowerCase() !== expected.hash.toLowerCase()) return held('torrent_unavailable');
    before = first[0];
    beforePaths = await read('properties', 'hash', 100_000);
    files = await read('files', 'hash', 2_000_000);
    const final = await read('info', 'hashes', 100_000);
    if (!Array.isArray(final) || final.length !== 1 ||
        final[0]?.hash?.toLowerCase() !== expected.hash.toLowerCase()) return held('torrent_changed');
    after = final[0];
    afterPaths = await read('properties', 'hash', 100_000);
    filesAfter = await read('files', 'hash', 2_000_000);
  } catch { return held('provider_unavailable'); }
  if ([beforePaths, afterPaths].some((value) =>
    typeof value?.save_path !== 'string' ||
    typeof value?.download_path !== 'string')) return held('storage_path_unverified');
  if (beforePaths.save_path !== afterPaths.save_path ||
      beforePaths.download_path !== afterPaths.download_path) {
    return held('storage_path_changed');
  }
  const safePath = (value) => value.save_path === expected.savePath &&
    (value.download_path === '' || value.download_path === expected.savePath);
  if (!safePath(beforePaths) || !safePath(afterPaths)) {
    return held('incomplete_path_outside_staging');
  }
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
  if (expectedFiles !== undefined) {
    if (!Array.isArray(expectedFiles) || expectedFiles.length < 1 ||
        expectedFiles.length > 500 || expectedFiles.some((file) =>
          typeof file?.name !== 'string' || !file.name ||
          !Number.isSafeInteger(file.size) || file.size < 1)) {
      throw new TypeError('Invalid expected torrent files');
    }
    const signature = (items) => items.map((file) =>
      `${file.name}\0${file.size}`).sort();
    if (JSON.stringify(signature(filesAfter)) !== JSON.stringify(signature(expectedFiles))) {
      return held('metainfo_manifest_mismatch');
    }
  }
  return evaluateStoppedManifest({ torrent: after, files: filesAfter, expected,
    allowSelectedPassive });
}
