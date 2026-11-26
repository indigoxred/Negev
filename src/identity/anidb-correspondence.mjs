import { MAX_ACQUISITION_VIDEOS, MAX_ACQUISITION_TARGETS } from '../acquisition/torrent-file-limits.mjs';
import { basename } from 'node:path';
import { cancelResponseBody, readBoundedJson } from '../http/bounded-response.mjs';

const validId = (value) => Number.isSafeInteger(value) && value > 0;
const hex = (value, length) => typeof value === 'string' &&
  new RegExp(`^[a-f0-9]{${length}}$`, 'i').test(value);
const unknown = (reason) => ({ state: 'unknown', reason });

function advertisedCrc(name) {
  // Only a complete checksum field in the actual filename, never a directory,
  // release-group name, title fragment, BitTorrent hash or episode number.
  const values = [...basename(name.replaceAll('\\', '/'))
    .matchAll(/(?:\[([a-f0-9]{8})\]|\(([a-f0-9]{8})\))/gi)]
    .map((match) => (match[1] ?? match[2]).toUpperCase());
  return new Set(values).size === 1 ? values[0] : null;
}

function correspondence(rows, { anidbId, file, kind, hash }) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 200 ||
      rows.some((row) => !validId(row?.anidb_file_id) ||
        row.anidb_id !== anidbId || row.size !== file.size ||
        !validId(row.anidb_episode_id) ||
        !hex(row[kind], kind === 'crc32' ? 8 : 32) ||
        row[kind].toLowerCase() !== hash.toLowerCase()) ||
      new Set(rows.map((row) => row.anidb_file_id)).size !== 1) return null;
  const found = [...new Set(rows.map((row) => row.anidb_episode_id))].sort((a, b) => a - b);
  const wanted = [...file.episodeIds].sort((a, b) => a - b);
  if (JSON.stringify(found) !== JSON.stringify(wanted)) return null;
  return { anidbFileId: rows[0].anidb_file_id, episodeIds: found };
}

// Optional read-only enrichment, shared for the service lifetime. Neither an
// absent checksum nor an outage is a rejection or an acquisition prerequisite.
// CRC+size is publisher-advertised correspondence, not proof of future bytes.
export function createAniDbCorrespondence({ fetchImpl = fetch,
  readPreviouslyVerified = async () => null, now = Date.now,
  maxCacheEntries = 512, maxLookups = 8, maxElapsedMs = 3_000,
  timeoutMs = 1_000 } = {}) {
  if ([fetchImpl, readPreviouslyVerified, now].some((fn) => typeof fn !== 'function') ||
      !Number.isInteger(maxCacheEntries) || maxCacheEntries < 1 || maxCacheEntries > 2048 ||
      !Number.isInteger(maxLookups) || maxLookups < 1 || maxLookups > 50 ||
      !Number.isInteger(maxElapsedMs) || maxElapsedMs < 1 || maxElapsedMs > 5_000 ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_000) {
    throw new TypeError('Invalid AniDB correspondence bounds');
  }
  const cache = new Map();
  const inFlight = new Map();
  let minuteStart = now(), minuteCalls = 0;
  const bounded = async (operation, remaining) => {
    if (remaining <= 0) return null;
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => operation(controller.signal)).catch(() => null),
        new Promise((resolve) => { timer = setTimeout(() => {
          controller.abort(); resolve(null);
        }, Math.min(timeoutMs, remaining)); }),
      ]);
    } finally { clearTimeout(timer); }
  };
  const lookup = async (kind, hash, size, budget) => {
    const key = `${kind}:${hash.toUpperCase()}:${size}`;
    const cached = cache.get(key);
    if (cached && now() < cached.until) {
      cache.delete(key); cache.set(key, cached); return cached.rows;
    }
    cache.delete(key);
    if (inFlight.has(key)) return bounded(() => inFlight.get(key), budget.remaining());
    if (now() - minuteStart >= 60_000) { minuteStart = now(); minuteCalls = 0; }
    if (budget.calls >= maxLookups || budget.remaining() <= 0 ||
        minuteCalls >= 60 || inFlight.size >= 2) return null;
    budget.calls++; minuteCalls++;
    const task = bounded(async (signal) => {
      const url = new URL('https://animap.id/api/anidb/file');
      url.searchParams.set(kind, hash); url.searchParams.set('size', String(size));
      const response = await fetchImpl(url, { method: 'GET', redirect: 'error',
        headers: { Accept: 'application/json' }, signal });
      if (response.status !== 200) await cancelResponseBody(response);
      if (response.status !== 200) return null;
      const rows = await readBoundedJson(response, 200_000);
      return Array.isArray(rows) && rows.length <= 200 ? rows : null;
    }, budget.remaining());
    inFlight.set(key, task);
    try {
      const rows = await task;
      // Cache raw records; every caller revalidates its own title/episode/size.
      cache.set(key, { rows, until: now() + (rows?.length ? 6 * 60 * 60_000 : 5 * 60_000) });
      while (cache.size > maxCacheEntries) cache.delete(cache.keys().next().value);
      return rows;
    } finally { inFlight.delete(key); }
  };
  return async ({ anidbId, torrentHash, files, filenamePrediction = false } = {}) => {
    if (!validId(anidbId) || !hex(torrentHash, 40) && !hex(torrentHash, 64) ||
        !Array.isArray(files) || files.length < 1 || files.length > MAX_ACQUISITION_VIDEOS ||
        files.some((file) => typeof file?.name !== 'string' || file.name.length > 1000 ||
          !validId(file.size) || !Array.isArray(file.episodeIds) ||
          file.episodeIds.length < 1 || file.episodeIds.length > MAX_ACQUISITION_TARGETS ||
          file.episodeIds.some((id) => !validId(id)))) {
      return { state: 'unknown', files: [] };
    }
    const start = performance.now();
    const budget = { calls: 0, remaining: () => maxElapsedMs - (performance.now() - start) };
    const evidence = [];
    for (const file of files) {
      const prior = await bounded((signal) => readPreviouslyVerified({ anidbId,
        torrentHash, file, signal }), budget.remaining());
      let result;
      if (prior?.size === file.size && hex(prior.ed2k, 32)) {
        const rows = await lookup('ed2k', prior.ed2k.toLowerCase(), file.size, budget);
        const exact = correspondence(rows, { anidbId, file, kind: 'ed2k', hash: prior.ed2k });
        if (exact) result = { state: 'previously_verified',
          basis: 'previously_downloaded_ed2k_and_size', ...exact };
      }
      const crc32 = advertisedCrc(file.name);
      if (!result && crc32) {
        const rows = await lookup('crc32', crc32, file.size, budget);
        const likely = correspondence(rows, { anidbId, file, kind: 'crc32', hash: crc32 });
        if (likely) result = { state: 'likely', basis: 'advertised_crc32_and_size',
          crc32, ...likely };
      }
      evidence.push({ name: file.name, size: file.size,
        ...(result ?? (filenamePrediction ? { state: 'filename_prediction',
          basis: 'shoko_filename_prediction', registration: 'unknown' } :
          unknown(crc32 ? 'correspondence_unconfirmed' : 'no_advertised_checksum'))) });
    }
    const all = (state) => evidence.every((file) => file.state === state);
    const known = (file) => ['previously_verified', 'likely'].includes(file.state);
    return { state: all('previously_verified') ? 'previously_verified' :
      evidence.every(known) ? 'likely' : evidence.some(known) ? 'partial' :
        all('filename_prediction') ? 'filename_prediction' : 'unknown', files: evidence };
  };
}
