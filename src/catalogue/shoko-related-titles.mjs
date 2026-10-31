import { readBoundedJson } from '../http/bounded-response.mjs';
import { readAniDbRelations } from './shoko-relations.mjs';

const FAMILY_TYPES = new Set(['SameSetting', 'AlternativeSetting',
  'AlternativeVersion', 'Prequel', 'Sequel', 'MainStory', 'SideStory',
  'FullStory', 'Summary']);

// One direct-neighbor view, never a claim that all franchise members exist
// in Shoko's cache. Both endpoints are read-only and scoped to one title.
export async function readAniDbRelatedTitles({ baseUrl, apiKey, anidbId,
  fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const relation = await readAniDbRelations({ baseUrl, apiKey, anidbId,
    fetchImpl, timeoutMs });
  if (relation.state !== 'relations') return relation;
  const edges = relation.items.filter((item) => FAMILY_TYPES.has(item.type));
  if (edges.some((item) => !item.verified) || edges.length > 50) {
    return { state: 'held', reason: 'relation_review_required' };
  }
  if (edges.length === 0) return { state: 'related_titles', anidbId,
    completeness: 'unproven', items: [] };
  let body;
  try {
    const url = new URL(`/api/v3/Series/AniDB/${anidbId}/Related`, baseUrl);
    const response = await fetchImpl(url, { method: 'GET', redirect: 'manual',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs) });
    if (response.status !== 200) return { state: 'unavailable' };
    body = await readBoundedJson(response, 500_000);
  } catch { return { state: 'unavailable' }; }
  if (!Array.isArray(body) || body.length > 200) return { state: 'unavailable' };
  const titles = new Map();
  for (const item of body) {
    if (!Number.isSafeInteger(item?.ID) || item.ID <= 0 ||
        titles.has(item.ID) || typeof item.Title !== 'string' ||
        !item.Title.trim()) return { state: 'unavailable' };
    titles.set(item.ID, item.Title.trim());
  }
  if (edges.some((item) => !titles.has(item.relatedId))) {
    return { state: 'unavailable' };
  }
  return { state: 'related_titles', anidbId, completeness: 'unproven',
    items: edges.map((item) => ({ anidbId: item.relatedId,
      title: titles.get(item.relatedId), relation: item.type })) };
}
