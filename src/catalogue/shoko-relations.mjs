import { readBoundedJson } from '../http/bounded-response.mjs';

const validId = (value) => Number.isSafeInteger(value) && value > 0;
const TYPES = new Set(['Other', 'SameSetting', 'AlternativeSetting',
  'AlternativeVersion', 'SharedCharacters', 'Prequel', 'MainStory',
  'FullStory', 'Sequel', 'SideStory', 'Summary']);

// One AniDB title's direct relation edges. This is not a transitive franchise
// graph and an empty row is not proof that the wider AniDB family is empty.
export async function readAniDbRelations({ baseUrl, apiKey, anidbId,
  fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  let base;
  try { base = new URL(baseUrl); } catch { throw new TypeError('Invalid Shoko URL'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
      base.search || base.hash || base.pathname !== '/' ||
      typeof apiKey !== 'string' || !apiKey || /[\r\n]/.test(apiKey) ||
      !validId(anidbId) || typeof fetchImpl !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError('Invalid AniDB relation lookup');
  }
  let relations;
  try {
    const url = new URL(`/api/v3/Series/AniDB/${anidbId}/Relations`, base);
    const response = await fetchImpl(url, { method: 'GET', redirect: 'manual',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs) });
    if (response.status === 404) return { state: 'detail_pending', anidbId };
    if (response.status !== 200) return { state: 'unavailable' };
    relations = await readBoundedJson(response, 250_000);
  } catch { return { state: 'unavailable' }; }
  if (!Array.isArray(relations) || relations.length > 200) {
    return { state: 'unavailable' };
  }
  const seen = new Set();
  const items = [];
  for (const relation of relations) {
    const left = relation?.IDs?.AniDB;
    const right = relation?.RelatedIDs?.AniDB;
    const relatedId = left === anidbId ? right : right === anidbId ? left : null;
    if (!validId(left) || !validId(right) || left === right ||
        !validId(relatedId) || seen.has(relatedId) ||
        !TYPES.has(relation.Type) || relation.Source !== 'AniDB' ||
        typeof relation.Verified !== 'boolean') {
      return { state: 'unavailable' };
    }
    seen.add(relatedId);
    items.push({ relatedId, type: relation.Type,
      verified: relation.Verified });
  }
  return { state: 'relations', anidbId, items };
}
