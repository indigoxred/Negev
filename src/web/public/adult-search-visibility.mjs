import { createCatalogueReadPacer } from './search-pages.mjs';

export function createAdultSearchVerifier({ readDisplay, concurrency = 4,
  now = Date.now,
  pacer = createCatalogueReadPacer({burst:4}) }) {
  if (typeof readDisplay !== 'function' || !Number.isSafeInteger(concurrency) ||
      concurrency < 1 || concurrency > 8) {
    throw new TypeError('Invalid adult search verifier');
  }
  const confirmed = new Map(), pending = new Map();
  return { async verify(ids, onClassified, { current = () => true,
    session = 0, refreshMetadata = false } = {}) {
    if (!Array.isArray(ids) || typeof onClassified !== 'function' ||
        !Number.isSafeInteger(session) || session < 0 ||
        typeof refreshMetadata !== 'boolean') {
      throw new TypeError('Invalid search verification');
    }
    const unique = [...new Set(ids)].filter(id => Number.isSafeInteger(id) && id > 0);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) },
      async () => {
        while (next < unique.length && current()) {
          const id = unique[next++];
          // Authorization belongs to the initiating session. Mutable library
          // proof must be read again when an ID-only result needs hydration.
          const key = `${session}:${id}`;
          let display = refreshMetadata ? undefined : confirmed.get(key);
          if (display === undefined) {
            let entry = pending.get(key);
            if (!entry) {
              entry = { consumers: new Set() };
              pending.set(key, entry);
              entry.consumers.add(current);
              let expiresMs = Infinity;
              const live = () => now() < expiresMs && [...entry.consumers].some(isCurrent => isCurrent());
              // Retry only transient classification failures, within this live
              // pass. All attempts share the existing pacing/cooldown budget.
              entry.promise = (async () => {
                for (let attempt = 0; attempt < 3 && live(); attempt++) {
                  try {
                    return await pacer.run(async () => {
                      const result = await readDisplay(id);
                      if (live() && result?.state === 'display' && result.anidbId === id &&
                          typeof result.restricted === 'boolean') {
                        confirmed.set(key, result);
                        while (confirmed.size > 500) confirmed.delete(confirmed.keys().next().value);
                        return result;
                      }
                    }, live);
                  } catch (error) {
                    if (![429, 503].includes(error?.status)) return undefined;
                    if (expiresMs === Infinity) expiresMs = now() + 180_000;
                    pacer.defer(error.retryAfter,
                      error.status === 429 ? 60_000 : 5000);
                  }
                }
                return undefined;
              })()
                .finally(() => { if (pending.get(key) === entry) pending.delete(key); });
            } else entry.consumers.add(current);
            display = await entry.promise;
            entry.consumers.delete(current);
          }
          if (display !== undefined && current()) onClassified(id, display.restricted, display);
        }
      }));
  } };
}
