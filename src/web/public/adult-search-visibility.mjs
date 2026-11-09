export function createAdultSearchVerifier({ readDisplay, concurrency = 4 }) {
  if (typeof readDisplay !== 'function' || !Number.isSafeInteger(concurrency) ||
      concurrency < 1 || concurrency > 8) {
    throw new TypeError('Invalid adult search verifier');
  }
  const confirmed = new Map();
  return { async verify(ids, onClassified) {
    if (!Array.isArray(ids) || typeof onClassified !== 'function') {
      throw new TypeError('Invalid search verification');
    }
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) },
      async () => {
        while (next < ids.length) {
          const id = ids[next++];
          if (!Number.isSafeInteger(id) || id < 1) continue;
          let adult = confirmed.get(id);
          if (adult === undefined) {
            try {
              const result = await readDisplay(id);
              if (result?.state === 'display' && result.anidbId === id &&
                  typeof result.restricted === 'boolean') {
                adult = result.restricted;
                confirmed.set(id, adult);
              }
            } catch { /* Keep an unverified title hidden. */ }
          }
          if (adult !== undefined) onClassified(id, adult);
        }
      }));
  } };
}
