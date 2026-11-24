import { createCatalogueReadPacer } from './search-pages.mjs';

export function createAdultSearchVerifier({ readDisplay, concurrency = 4,
  pacer = createCatalogueReadPacer() }) {
  if (typeof readDisplay !== 'function' || !Number.isSafeInteger(concurrency) ||
      concurrency < 1 || concurrency > 8) {
    throw new TypeError('Invalid adult search verifier');
  }
  const confirmed = new Map(), pending = new Map();
  return { async verify(ids, onClassified, { current = () => true } = {}) {
    if (!Array.isArray(ids) || typeof onClassified !== 'function') {
      throw new TypeError('Invalid search verification');
    }
    const unique = [...new Set(ids)].filter(id => Number.isSafeInteger(id) && id > 0);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) },
      async () => {
        while (next < unique.length && current()) {
          const id = unique[next++];
          let adult = confirmed.get(id);
          if (adult === undefined) {
            let entry = pending.get(id);
            if (!entry) {
              entry = { consumers: new Set() };
              pending.set(id, entry);
              entry.consumers.add(current);
              entry.promise = pacer.run(async () => {
                const result = await readDisplay(id);
                if (result?.state === 'display' && result.anidbId === id &&
                    typeof result.restricted === 'boolean') {
                  confirmed.set(id, result.restricted);
                  while (confirmed.size > 500) confirmed.delete(confirmed.keys().next().value);
                  return result.restricted;
                }
              }, () => [...entry.consumers].some(isCurrent => isCurrent()))
                .catch(error => {
                  if ([429, 503].includes(error?.status)) pacer.defer(error.retryAfter,
                    error.status === 429 ? 60_000 : 5000);
                  return undefined;
                })
                .finally(() => { if (pending.get(id) === entry) pending.delete(id); });
            } else entry.consumers.add(current);
            adult = await entry.promise;
            entry.consumers.delete(current);
          }
          if (adult !== undefined && current()) onClassified(id, adult);
        }
      }));
  } };
}
