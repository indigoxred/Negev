// A successful search is the only source of title IDs for the private
// detail-load prototype. This bounded in-memory proof is lost on restart.
export function createObservedTitleRegistry({ ttlMs = 15 * 60_000, maxEntries = 500, now = Date.now } = {}) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 ||
      !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 10_000 ||
      typeof now !== 'function') throw new TypeError('Invalid title registry configuration');
  const seen = new Map();
  function prune(time) {
    for (const [id, item] of seen) if (item.expiry <= time) seen.delete(id);
  }
  return {
    observe(result) {
      if (result?.state !== 'results' || !Number.isSafeInteger(result.total) || result.total < 0 ||
          !Array.isArray(result.items) || result.items.length > result.total ||
          result.items.some((item) => !Number.isSafeInteger(item?.anidbId) || item.anidbId <= 0 ||
            typeof item.title !== 'string' || !item.title.trim())) return false;
      const time = now();
      if (!Number.isSafeInteger(time) || time < 0 || !Number.isSafeInteger(time + ttlMs)) return false;
      prune(time);
      for (const item of result.items) {
        seen.delete(item.anidbId);
        seen.set(item.anidbId, { title: item.title.trim(), expiry: time + ttlMs });
      }
      while (seen.size > maxEntries) seen.delete(seen.keys().next().value);
      return true;
    },
    isKnownTitle({ anidbId }) {
      if (!Number.isSafeInteger(anidbId) || anidbId <= 0) return false;
      const time = now();
      if (!Number.isSafeInteger(time) || time < 0) return false;
      prune(time);
      return seen.has(anidbId);
    },
    getTitle({ anidbId }) {
      if (!Number.isSafeInteger(anidbId) || anidbId <= 0) return null;
      const time = now();
      if (!Number.isSafeInteger(time) || time < 0) return null;
      prune(time);
      return seen.get(anidbId)?.title ?? null;
    },
  };
}
