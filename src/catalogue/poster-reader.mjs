import { readAniDbPoster } from './anidb-poster.mjs';

// Lazy poster reads are separate from Shoko metadata and capped so a full
// search page cannot produce an unbounded burst of outbound requests.
export function createPosterReader({ fetchImpl = fetch, now = Date.now,
  concurrency = 3, maxCacheBytes = 48_000_000 } = {}) {
  if (typeof fetchImpl !== 'function' || typeof now !== 'function' ||
      !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4 ||
      !Number.isSafeInteger(maxCacheBytes) || maxCacheBytes < 1 ||
      maxCacheBytes > 64_000_000) {
    throw new TypeError('Invalid poster reader');
  }
  const cache = new Map();
  const inflight = new Map();
  const pending = [];
  let cacheBytes = 0;
  let active = 0;
  const drop = (id) => {
    const old = cache.get(id);
    if (old) cacheBytes -= old.size;
    cache.delete(id);
  };
  const pump = () => {
    while (active < concurrency && pending.length > 0) {
      const job = pending.shift();
      active++;
      Promise.resolve().then(() => readAniDbPoster({
        anidbId: job.anidbId, fetchImpl,
      })).then((result) => {
        drop(job.anidbId);
        const size = result.state === 'image' ? result.bytes.length : 0;
        if (size <= maxCacheBytes) {
          cache.set(job.anidbId, { result, size,
            expiresMs: now() + (result.state === 'image' ? 86_400_000 : 600_000) });
          cacheBytes += size;
          while (cache.size > 500 || cacheBytes > maxCacheBytes) {
            drop(cache.keys().next().value);
          }
        }
        return result;
      }).catch(() => ({ state: 'unavailable' }))
        .then((result) => {
          inflight.delete(job.anidbId);
          job.resolve(result);
        })
        .finally(() => { active--; pump(); });
    }
  };
  return {
    read({ anidbId }) {
      if (!Number.isSafeInteger(anidbId) || anidbId < 1) {
        throw new TypeError('Invalid AniDB poster ID');
      }
      const hit = cache.get(anidbId);
      if (hit && hit.expiresMs > now()) {
        cache.delete(anidbId);
        cache.set(anidbId, hit);
        return Promise.resolve(hit.result);
      }
      if (hit) drop(anidbId);
      if (inflight.has(anidbId)) return inflight.get(anidbId);
      if (pending.length >= 40) return Promise.resolve({ state: 'unavailable' });
      const result = new Promise((resolve) => {
        pending.push({ anidbId, resolve }); pump();
      });
      inflight.set(anidbId, result);
      return result;
    },
  };
}
