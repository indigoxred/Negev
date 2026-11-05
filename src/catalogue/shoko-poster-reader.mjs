import { readShokoPoster, validPosterUid } from './shoko-poster.mjs';

// Artwork has its own bounded queue so a grid cannot monopolise the single
// Shoko metadata slot or turn concurrent covers into retryable busy results.
export function createShokoPosterReader({ baseUrl, apiKey,
  fetchImpl = fetch, now = Date.now, concurrency = 2,
  maxCacheBytes = 48_000_000 } = {}) {
  if (typeof baseUrl !== 'string' || typeof apiKey !== 'string' || !apiKey ||
      typeof fetchImpl !== 'function' || typeof now !== 'function' ||
      !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 3 ||
      !Number.isSafeInteger(maxCacheBytes) || maxCacheBytes < 1 ||
      maxCacheBytes > 64_000_000) {
    throw new TypeError('Invalid Shoko poster reader');
  }
  const cache = new Map();
  const inflight = new Map();
  const pending = [];
  let active = 0;
  let cacheBytes = 0;
  const drop = (id) => {
    const old = cache.get(id);
    if (old) cacheBytes -= old.size;
    cache.delete(id);
  };
  const pump = () => {
    while (active < concurrency && pending.length) {
      const job = pending.shift();
      active++;
      Promise.resolve().then(() => readShokoPoster({ baseUrl, apiKey,
        uid: job.uid, fetchImpl })).catch(() => ({ state: 'unavailable' }))
        .then((value) => {
          const size = value.state === 'image' ? value.bytes.length : 0;
          drop(job.uid);
          if (size <= maxCacheBytes) {
            cache.set(job.uid, { value, size, expiresMs: now() +
              (value.state === 'image' ? 86_400_000 : 600_000) });
            cacheBytes += size;
            while (cache.size > 500 || cacheBytes > maxCacheBytes) {
              drop(cache.keys().next().value);
            }
          }
          inflight.delete(job.uid);
          job.resolve(value);
        }).finally(() => { active--; pump(); });
    }
  };
  return { read({ uid }) {
    if (!validPosterUid(uid)) throw new TypeError('Invalid Shoko poster UID');
    const hit = cache.get(uid);
    if (hit && hit.expiresMs > now()) {
      cache.delete(uid);
      cache.set(uid, hit);
      return Promise.resolve(hit.value);
    }
    if (hit) drop(uid);
    if (inflight.has(uid)) return inflight.get(uid);
    if (pending.length >= 40) return Promise.resolve({ state: 'unavailable' });
    const result = new Promise((resolve) => {
      pending.push({ uid, resolve }); pump();
    });
    inflight.set(uid, result);
    return result;
  } };
}
