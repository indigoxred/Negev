import { readBoundedJson } from '../http/bounded-response.mjs';

// Display may use the archive's AniDB IDs when Shoko has not verified its
// relation cache. Acquisition keeps its separate, stricter relation guard.
export function preferDisplayRelations(local, archive) {
  if (local?.state === 'related_titles' && local.items.length > 0) return local;
  return archive?.state === 'related_titles' ? archive : local;
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
