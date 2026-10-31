import { gunzipSync } from 'node:zlib';
import { parseAniDbTitleDump, searchAniDbTitleIndex } from './anidb-title-index.mjs';

const DUMP_URL = 'https://anidb.net/api/anime-titles.dat.gz';

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

// Candidate source only. It is not wired to user search until the live dump
// format and update behavior are checked. A failed refresh retains only the
// prior verified in-memory index, visibly marked stale.
export function createAniDbTitleSource({ fetchImpl = fetch, now = Date.now,
  maxCompressedBytes = 12_000_000,
  maxExpandedBytes = 32_000_000,
  refreshMs = 24 * 60 * 60_000,
  retryMs = 15 * 60_000,
  timeoutMs = 20_000 } = {}) {
  if (typeof fetchImpl !== 'function' || typeof now !== 'function' ||
      !Number.isSafeInteger(maxCompressedBytes) || maxCompressedBytes < 1 ||
      maxCompressedBytes > 32_000_000 ||
      !Number.isSafeInteger(maxExpandedBytes) || maxExpandedBytes < 1 ||
      maxExpandedBytes > 64_000_000 ||
      !Number.isSafeInteger(refreshMs) || refreshMs < 60_000 ||
      !Number.isSafeInteger(retryMs) || retryMs < 60_000 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError('Invalid AniDB title source');
  }
  let index = null;
  let lastSuccessMs = null;
  let lastAttemptMs = null;
  let inflight = null;
  async function load() {
    const started = now();
    if (!Number.isSafeInteger(started) || started < 0) {
      return { state: index ? 'stale' : 'unavailable',
        ...(index ? { titles: index.size } : {}) };
    }
    if (index && lastSuccessMs !== null && started >= lastSuccessMs &&
        started - lastSuccessMs < refreshMs) {
      return { state: 'ready', titles: index.size };
    }
    if (lastAttemptMs !== null && started >= lastAttemptMs &&
        started - lastAttemptMs < retryMs) {
      return { state: index ? 'stale' : 'unavailable',
        ...(index ? { titles: index.size } : {}) };
    }
    lastAttemptMs = started;
    try {
      const response = await fetchImpl(DUMP_URL, { method: 'GET',
        redirect: 'manual', headers: { Accept: 'application/gzip' },
        signal: AbortSignal.timeout(timeoutMs) });
      if (response.status !== 200) throw new TypeError('Title dump unavailable');
      const compressed = await readCompressed(response, maxCompressedBytes);
      const expanded = gunzipSync(compressed, { maxOutputLength: maxExpandedBytes });
      const text = new TextDecoder('utf-8', { fatal: true }).decode(expanded);
      const next = parseAniDbTitleDump(text, { maxBytes: maxExpandedBytes });
      index = next;
      lastSuccessMs = started;
      return { state: 'ready', titles: index.size };
    } catch {
      return { state: index ? 'stale' : 'unavailable',
        ...(index ? { titles: index.size } : {}) };
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
  };
}
