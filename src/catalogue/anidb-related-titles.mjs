import { readBoundedJson } from '../http/bounded-response.mjs';

// Display merges exact AniDB IDs from the Shoko cache and archive. A local
// title/relation wins on duplicate IDs. Acquisition uses its separate guard.
export function preferDisplayRelations(local, archive) {
  if (local?.state === 'related_titles' && local.items.length > 0) {
    if (archive?.state !== 'related_titles' ||
        archive.anidbId !== local.anidbId) return local;
    const known = new Set(local.items.map((item) => item.anidbId));
    const items = [...local.items];
    for (const item of archive.items) {
      if (items.length >= 50) break;
      if (!known.has(item.anidbId)) {
        known.add(item.anidbId);
        items.push(item);
      }
    }
    return { ...local, items };
  }
  return archive?.state === 'related_titles' ? archive : local;
}
export async function readDisplayRelations({ readLocal, readArchive,
  mergeWaitMs = 250 }) {
  if (!Number.isSafeInteger(mergeWaitMs) || mergeWaitMs < 1 || mergeWaitMs > 1_000) {
    throw new TypeError('Invalid relation merge wait');
  }
  const localRead = Promise.resolve().then(readLocal)
    .catch(() => ({ state: 'unavailable' }));
  const archiveRead = Promise.resolve().then(readArchive)
    .catch(() => ({ state: 'unavailable' }));
  const first = await Promise.race([
    localRead.then((result) => ({ source: 'local', result })),
    archiveRead.then((result) => ({ source: 'archive', result })),
  ]);
  const otherRead = first.source === 'local' ? archiveRead : localRead;
  const usable = first.result?.state === 'related_titles' &&
    first.result.items?.length > 0;
  let timer;
  const other = usable ? await Promise.race([otherRead,
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), mergeWaitMs); })])
    : await otherRead;
  clearTimeout(timer);
  return first.source === 'local'
    ? preferDisplayRelations(first.result, other)
    : preferDisplayRelations(other, first.result);
}

// Related titles are display-only. A short shared cache prevents several
// viewers from multiplying Shoko/AniMap reads, and a recently checked result
// can keep the franchise shelf usable during a transient provider outage.
export function createCachedDisplayRelations({ read, now = Date.now,
  freshMs = 60 * 60_000, staleMs = 24 * 60 * 60_000,
  maxEntries = 256 } = {}) {
  if (typeof read !== 'function' || typeof now !== 'function' ||
      !Number.isSafeInteger(freshMs) || freshMs < 1 ||
      !Number.isSafeInteger(staleMs) || staleMs < freshMs ||
      !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 1_000) {
    throw new TypeError('Invalid related-title cache');
  }
  const cache = new Map();
  const pending = new Map();
  return async ({ anidbId } = {}) => {
    if (!Number.isSafeInteger(anidbId) || anidbId < 1) {
      throw new TypeError('Invalid AniDB ID');
    }
    const cached = cache.get(anidbId);
    const age = cached ? now() - cached.checkedMs : Infinity;
    if (age >= 0 && age < freshMs) return cached.result;
    if (pending.has(anidbId)) return pending.get(anidbId);
    const request = Promise.resolve().then(() => read({ anidbId }))
      .catch(() => ({ state: 'unavailable' }))
      .then((result) => {
        if (result?.state === 'related_titles' &&
            result.anidbId === anidbId &&
            result.completeness === 'unproven' &&
            Array.isArray(result.items) && result.items.length > 0 &&
            result.items.length <= 50) {
          cache.delete(anidbId);
          cache.set(anidbId, { result, checkedMs: now() });
          if (cache.size > maxEntries) cache.delete(cache.keys().next().value);
          return result;
        }
        return age >= 0 && age <= staleMs ? cached.result : result;
      })
      .finally(() => pending.delete(anidbId));
    pending.set(anidbId, request);
    return request;
  };
}

// Display-only AniDB relationships for titles Shoko has not cached. These
// are exact AniDB IDs, never a title-match or an acquisition identity proof.
export async function readAniDbRelatedTitles({ anidbId, titleForId,
  fetchImpl = fetch, timeoutMs = 8_000 } = {}) {
  if (!Number.isSafeInteger(anidbId) || anidbId < 1 ||
      typeof titleForId !== 'function' || typeof fetchImpl !== 'function') {
    throw new TypeError('Invalid AniDB related-title request');
  }
  try {
    const response = await fetchImpl(`https://animap.id/api/anidb/${anidbId}`, {
      method: 'GET', redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status !== 200) return { state: 'unavailable' };
    const data = await readBoundedJson(response, 64_000);
    if (data?.anidb_id !== anidbId || !Array.isArray(data.relatedanime) ||
        data.relatedanime.length > 50) return { state: 'unavailable' };
    const ids = new Set();
    const items = [];
    for (const row of data.relatedanime) {
      const id = row?.anidb_id;
      if (!Number.isSafeInteger(id) || id < 1 || id === anidbId || ids.has(id) ||
          typeof row.type !== 'string' || row.type.length > 40) {
        return { state: 'unavailable' };
      }
      ids.add(id);
      const title = titleForId(id);
      items.push({ anidbId: id,
        title: typeof title === 'string' && title.trim() ? title : `AniDB ${id}`,
        relation: row.type });
    }
    return { state: 'related_titles', anidbId, completeness: 'unproven', items };
  } catch { return { state: 'unavailable' }; }
}
