import { evaluateCompletion } from './evaluate-completion.mjs';

const held = (reason) => ({ state: 'held', reason });

// A narrow qBittorrent v5 observer. A complete manifest permits the later
// AniDB byte check; it does not permit an import by itself.
export async function observeTorrentCompletion({
  baseUrl, sessionId, expected, fetchImpl = fetch, timeoutMs = 10_000,
}) {
  let base;
  try { base = new URL(baseUrl); } catch { throw new TypeError('Invalid qBittorrent URL'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
      base.search || base.hash || base.pathname !== '/' ||
      typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(sessionId) ||
      !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(expected?.hash) ||
      typeof expected.category !== 'string' || !expected.category ||
      typeof expected.savePath !== 'string' || !expected.savePath.startsWith('/') ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError('Invalid qBittorrent observation configuration');
  }
  const headers = { Cookie: `SID=${sessionId}`, Accept: 'application/json' };
  const read = async (endpoint, parameter, maxChars) => {
    const url = new URL(`/api/v2/torrents/${endpoint}`, base);
    url.searchParams.set(parameter, expected.hash);
    const response = await fetchImpl(url, { method: 'GET', headers, redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs) });
    if (response.status !== 200) throw new Error('qBittorrent read failed');
    const body = await response.text();
    if (body.length > maxChars) throw new Error('qBittorrent response too large');
    return JSON.parse(body);
  };
  let before, files, after, filesAfter;
  try {
    const first = await read('info', 'hashes', 100_000);
    if (!Array.isArray(first) || first.length !== 1 ||
        first[0]?.hash?.toLowerCase() !== expected.hash.toLowerCase()) {
      return held('torrent_unavailable');
    }
    before = first[0];
    files = await read('files', 'hash', 2_000_000);
    const final = await read('info', 'hashes', 100_000);
    if (!Array.isArray(final) || final.length !== 1 ||
        final[0]?.hash?.toLowerCase() !== expected.hash.toLowerCase()) {
      return held('torrent_changed');
    }
    after = final[0];
    filesAfter = await read('files', 'hash', 2_000_000);
  } catch { return held('provider_unavailable'); }
  if (!Array.isArray(files) || !Array.isArray(filesAfter) ||
      files.length > 500 || filesAfter.length > 500) return held('invalid_file_manifest');
  if (before.hash !== after.hash || before.category !== after.category ||
      before.save_path !== after.save_path || before.state !== after.state ||
      before.progress !== after.progress || before.amount_left !== after.amount_left ||
      before.auto_tmm !== after.auto_tmm || before.force_start !== after.force_start) {
    return held('torrent_changed');
  }
  const fingerprint = (list) => JSON.stringify(list.map((file) => [
    file.index, file.name, file.size, file.priority, file.progress, file.is_seed,
  ]));
  if (fingerprint(files) !== fingerprint(filesAfter)) return held('manifest_changed');
  return evaluateCompletion({ torrent: after, files, expected });
}
