import { collectAniDbDetail } from '../catalogue/collect-detail.mjs';

// A contiguous filename run alone cannot establish a sequel offset. Walk a
// bounded, unambiguous prequel chain and count regular episodes only. AniDB
// registration is deliberately not required. Unknown ancestry is no proof.
export async function verifyAbsoluteNumberingScope({ anidbId, offset,
  readRelatedTitles, loadDetail, related } = {}) {
  const unknown = () => ({ state: 'unverified' });
  if (!Number.isSafeInteger(anidbId) || anidbId < 1 ||
      !Number.isSafeInteger(offset) || offset < 1 || offset > 10000 ||
      typeof readRelatedTitles !== 'function' || typeof loadDetail !== 'function') return unknown();
  const seen = new Set([anidbId]); let current = anidbId, total = 0;
  for (let depth = 0; depth <= 4; depth++) {
    let relations;
    try { relations = depth === 0 && related ? related : await readRelatedTitles({ anidbId: current }); }
    catch { return unknown(); }
    if (relations?.state !== 'related_titles' || relations.anidbId !== current ||
        !Array.isArray(relations.items) || relations.items.length > 50) return unknown();
    const prequels = relations.items.filter(x => x.relation?.toLowerCase() === 'prequel');
    if (!prequels.length) return total === offset ? { state: 'scope_confirmed', offset,
      basis: 'regular_prequel_chain', prequelIds: [...seen].slice(1) } : unknown();
    if (depth === 4 || prequels.length !== 1) return unknown();
    const id = prequels[0].anidbId;
    if (!Number.isSafeInteger(id) || id < 1 || seen.has(id)) return unknown();
    const detail = await collectAniDbDetail({ anidbId: id, loadPage: loadDetail });
    if (detail.state !== 'details' || detail.kind !== 'series') return unknown();
    const regular = detail.episodes.filter(x => x.type === 'Episode').sort((a,b)=>a.number-b.number);
    if (!regular.length || !regular.every((x,i)=>x.number===i+1)) return unknown();
    total += regular.length;
    if (total > offset) return unknown();
    seen.add(id); current = id;
  }
  return unknown();
}
