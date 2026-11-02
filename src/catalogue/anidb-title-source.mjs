import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { parseAniDbTitleDumpAsync, searchAniDbTitleIndex } from './anidb-title-index.mjs';

const DUMP_URL = 'https://anidb.net/api/anime-titles.dat.gz';
const gunzipAsync = promisify(gunzip);

async function readCompressed(response, limit) {
  if (!response.body || typeof response.body[Symbol.asyncIterator] !== 'function') {
    throw new TypeError('Invalid title dump response');
  }
  const declared = response.headers?.get?.('content-length');
  if (declared != null && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    throw new TypeError('Title dump too large');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > limit) throw new TypeError('Title dump too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

// Optional source for user search. A failed refresh retains only the prior
// parsed in-memory index, visibly marked stale. Installed catalogue behavior
// still needs a live check before Negev's production cutover.
export function createAniDbTitleSource({ fetchImpl = fetch, now = Date.now,
  cachePath = null,
  maxCompressedBytes = 12_000_000,
  maxExpandedBytes = 32_000_000,
  refreshMs = 24 * 60 * 60_000,
  retryMs = 15 * 60_000,
  timeoutMs = 20_000, cachedTimeoutMs = 1_500 } = {}) {
  if (typeof fetchImpl !== 'function' || typeof now !== 'function' ||
      !Number.isSafeInteger(maxCompressedBytes) || maxCompressedBytes < 1 ||
      maxCompressedBytes > 32_000_000 ||
      !Number.isSafeInteger(maxExpandedBytes) || maxExpandedBytes < 1 ||
      maxExpandedBytes > 64_000_000 ||
      !Number.isSafeInteger(refreshMs) || refreshMs < 60_000 ||
      !Number.isSafeInteger(retryMs) || retryMs < 60_000 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 ||
      !Number.isSafeInteger(cachedTimeoutMs) || cachedTimeoutMs < 1 ||
      cachedTimeoutMs > 10_000) {
    throw new TypeError('Invalid AniDB title source');
  }
  if (cachePath !== null && (typeof cachePath !== 'string' ||
      !path.isAbsolute(cachePath) || path.normalize(cachePath) !== cachePath ||
      path.parse(cachePath).root === cachePath || /[\0\r\n]/.test(cachePath))) {
    throw new TypeError('Invalid AniDB title cache path');
  }
  let index = null;
  let cacheLoaded = false;
  let cacheWriteFailed = false;
  let lastSuccessMs = null;
  let lastAttemptMs = null;
  let inflight = null;
  const parseCompressed = async (bytes) => {
    const expanded = await gunzipAsync(bytes, { maxOutputLength: maxExpandedBytes });
    const text = new TextDecoder('utf-8', { fatal: true }).decode(expanded);
    return parseAniDbTitleDumpAsync(text, { maxBytes: maxExpandedBytes });
  };
  const readCache = async () => {
    if (cacheLoaded || cachePath === null) return;
    cacheLoaded = true;
    let handle;
    try {
      handle = await open(cachePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const before = await handle.stat();
      if (!before.isFile() || before.size < 1 || before.size > maxCompressedBytes) return;
      const bytes = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        const result = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (result.bytesRead < 1) return;
        offset += result.bytesRead;
      }
      const after = await handle.stat();
      if (before.dev !== after.dev || before.ino !== after.ino ||
          before.size !== after.size || before.mtimeMs !== after.mtimeMs) return;
      index = await parseCompressed(bytes);
    } catch { /* The live source can still refresh a bad or absent cache. */ }
    finally { try { await handle?.close(); } catch { /* Cache remains optional. */ } }
  };
  const saveCache = async (bytes) => {
    if (cachePath === null) return true;
    const temporary = `${cachePath}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporary, cachePath);
      return true;
    } catch {
      try { await handle?.close(); } catch { /* Preserve refresh. */ }
      try { await unlink(temporary); } catch { /* No temporary file. */ }
      return false;
    }
  };
  const status = (state) => ({ state,
    ...(index ? { titles: index.size } : {}),
    ...(cacheWriteFailed ? { cacheWriteFailed: true } : {}) });
  async function load() {
    await readCache();
    const started = now();
    if (!Number.isSafeInteger(started) || started < 0) {
      return status(index ? 'stale' : 'unavailable');
    }
    if (index && lastSuccessMs !== null && started >= lastSuccessMs &&
        started - lastSuccessMs < refreshMs) {
      return status('ready');
    }
    if (lastAttemptMs !== null && started >= lastAttemptMs &&
        started - lastAttemptMs < retryMs) {
      return status(index ? 'stale' : 'unavailable');
    }
    lastAttemptMs = started;
    try {
      const response = await fetchImpl(DUMP_URL, { method: 'GET',
        redirect: 'manual', headers: { Accept: 'application/gzip' },
        signal: AbortSignal.timeout(index ?
          Math.min(cachedTimeoutMs, timeoutMs) : timeoutMs) });
      if (response.status !== 200) throw new TypeError('Title dump unavailable');
      const compressed = await readCompressed(response, maxCompressedBytes);
      const next = await parseCompressed(compressed);
      index = next;
      lastSuccessMs = started;
      cacheWriteFailed = !(await saveCache(compressed));
      return status('ready');
    } catch {
      return status(index ? 'stale' : 'unavailable');
    }
  }
  return {
    refresh() {
      if (!inflight) {
        inflight = load().finally(() => { inflight = null; });
      }
      return inflight;
    },
    search(input) {
      return index ? searchAniDbTitleIndex(index, input) :
        { state: 'unavailable' };
    },
    releaseQueries(anidbId) {
      return Number.isSafeInteger(anidbId) && anidbId > 0
        ? [...(index?.get(anidbId)?.releaseQueries ?? [])] : [];
    },
  };
}
