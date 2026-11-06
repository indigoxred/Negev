import { readBoundedJson } from '../http/bounded-response.mjs';
import { evaluateCompletion } from './evaluate-completion.mjs';
import { qbittorrentSessionCookie, validQbittorrentSessionId } from
  './qbittorrent-session-cookie.mjs';

const held = (reason) => ({ state: 'held', reason });

// A narrow qBittorrent v5 observer. A complete manifest permits the later
// AniDB byte check; it does not permit an import by itself.
export async function observeTorrentCompletion({
  baseUrl, sessionId, expected, fetchImpl = fetch, timeoutMs = 10_000,
  onTransfer,
}) {
  let base;
  try { base = new URL(baseUrl); } catch { throw new TypeError('Invalid qBittorrent URL'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
      base.search || base.hash || base.pathname !== '/' ||
      !validQbittorrentSessionId(sessionId) ||
      !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(expected?.hash) ||
      typeof expected.category !== 'string' || !expected.category ||
      typeof expected.savePath !== 'string' || !expected.savePath.startsWith('/') ||
      (onTransfer !== undefined && typeof onTransfer !== 'function') ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError('Invalid qBittorrent observation configuration');
  }
  const headers = { Cookie: qbittorrentSessionCookie(sessionId),
    Accept: 'application/json' };
  let providerFailure = 'provider_unavailable';
  const timedOut = (error) => ['TimeoutError', 'AbortError'].includes(error?.name);
  const read = async (endpoint, parameter, maxChars) => {
    const url = new URL(`/api/v2/torrents/${endpoint}`, base);
    url.searchParams.set(parameter, expected.hash);
    let response;
    try {
      response = await fetchImpl(url, { method: 'GET', headers, redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      providerFailure = timedOut(error) ? 'provider_timeout' : 'provider_transport';
      throw error;
    }
    if (response.status !== 200) {
      providerFailure = response.status === 403 ? 'provider_http_403' : 'provider_http_error';
      throw new Error('qBittorrent read failed');
    }
    try { return await readBoundedJson(response, maxChars); }
    catch (error) {
      providerFailure = timedOut(error) ? 'provider_timeout' : 'provider_invalid_response';
      throw error;
    }
  };
  let before, beforePaths, files, after, afterPaths, filesAfter;
  try {
    const first = await read('info', 'hashes', 100_000);
    if (!Array.isArray(first) || first.length !== 1 ||
        first[0]?.hash?.toLowerCase() !== expected.hash.toLowerCase()) {
      return held('torrent_unavailable');
    }
    before = first[0];
    beforePaths = await read('properties', 'hash', 100_000);
    files = await read('files', 'hash', 2_000_000);
    const final = await read('info', 'hashes', 100_000);
    if (!Array.isArray(final) || final.length !== 1 ||
        final[0]?.hash?.toLowerCase() !== expected.hash.toLowerCase()) {
      return held('torrent_changed');
    }
    after = final[0];
    afterPaths = await read('properties', 'hash', 100_000);
    filesAfter = await read('files', 'hash', 2_000_000);
  } catch { return held(providerFailure); }
  if ([beforePaths, afterPaths].some((value) =>
    typeof value?.save_path !== 'string' ||
    typeof value?.download_path !== 'string')) return held('storage_path_unverified');
  const safePath = (value) => value.save_path === expected.savePath &&
    (value.download_path === '' || value.download_path === expected.savePath);
  if (beforePaths?.save_path !== afterPaths?.save_path ||
      beforePaths?.download_path !== afterPaths?.download_path) {
    return held('storage_path_changed');
  }
  if (!safePath(beforePaths) || !safePath(afterPaths)) {
    return held('incomplete_path_outside_staging');
  }
  if (!Array.isArray(files) || !Array.isArray(filesAfter) ||
      files.length > 500 || filesAfter.length > 500) return held('invalid_file_manifest');
  const beforeCompletion = evaluateCompletion({ torrent: before, files, expected });
  const afterCompletion = evaluateCompletion({ torrent: after, files: filesAfter, expected });
  const sameOwner = before.hash === after.hash &&
    before.category === expected.category && after.category === expected.category &&
    before.save_path === expected.savePath && after.save_path === expected.savePath &&
    before.auto_tmm === false && after.auto_tmm === false &&
    before.force_start === false && after.force_start === false;
  if (sameOwner && onTransfer &&
      ['downloading', 'forcedDL', 'stalledDL', 'queuedDL', 'pausedDL'].includes(after.state) &&
      Number.isFinite(after.progress) && after.progress >= 0 && after.progress < 1 &&
      Number.isSafeInteger(after.amount_left) && after.amount_left >= 0) {
    const eta = Number.isSafeInteger(after.eta) && after.eta > 0 &&
      after.eta <= 7 * 24 * 60 * 60 ? after.eta : null;
    const speed = Number.isSafeInteger(after.dlspeed) && after.dlspeed >= 0 &&
      after.dlspeed <= 10 * 1024 ** 3 ? after.dlspeed : null;
    const transferState = ['downloading', 'forcedDL'].includes(after.state)
      ? 'active' : after.state === 'stalledDL' ? 'stalled' :
        after.state === 'queuedDL' ? 'queued' : 'paused';
    try { onTransfer({ progressBasisPoints: Math.floor(after.progress * 10_000),
      etaSeconds: eta, speedBytesPerSecond: speed, transferState }); }
    catch { /* Display telemetry must never authorize or block an import. */ }
  }
  if (!sameOwner ||
      (before.state !== after.state &&
        (beforeCompletion.state !== 'complete' || afterCompletion.state !== 'complete')) ||
      before.progress !== after.progress || before.amount_left !== after.amount_left ||
      before.auto_tmm !== after.auto_tmm || before.force_start !== after.force_start) {
    return held(sameOwner && beforeCompletion.reason === 'incomplete' &&
      afterCompletion.reason === 'incomplete' ? 'incomplete' : 'torrent_changed');
  }
  const fingerprint = (list) => JSON.stringify(list.map((file) => [
    file.index, file.name, file.size, file.priority, file.progress, file.is_seed,
  ]));
  if (fingerprint(files) !== fingerprint(filesAfter)) return held(
    beforeCompletion.reason === 'incomplete' &&
      afterCompletion.reason === 'incomplete' ? 'incomplete' : 'manifest_changed');
  return afterCompletion;
}
