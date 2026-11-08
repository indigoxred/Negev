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
export async function readDisplayRelations({ readLocal, readArchive }) {
  const [local, archive] = await Promise.all([
    Promise.resolve().then(readLocal).catch(() => ({ state: 'unavailable' })),
    Promise.resolve().then(readArchive).catch(() => ({ state: 'unavailable' })),
  ]);
  return preferDisplayRelations(local, archive);
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
