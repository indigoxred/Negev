import { collectAniDbDetail } from '../catalogue/collect-detail.mjs';

// A contiguous filename run alone cannot establish a sequel offset. Walk a
// bounded, unambiguous prequel chain and count regular episodes only. AniDB
// registration is deliberately not required. Unknown ancestry is no proof.
export async function verifyAbsoluteNumberingScope({ anidbId, offset,
  readRelatedTitles, loadDetail, related } = {}) {
  const unknown = reason => ({ state: 'unverified', ...(reason ? { reason } : {}) });
  const providerUnavailable = result => ['unavailable', 'detail_pending'].includes(result?.state) ||
    result?.state === 'held' && ['provider_unavailable', 'metadata_reader_busy',
      'detail_unavailable', 'related_title_unavailable'].includes(result.reason);
  if (!Number.isSafeInteger(anidbId) || anidbId < 1 ||
      !Number.isSafeInteger(offset) || offset < 1 || offset > 10000 ||
      typeof readRelatedTitles !== 'function' || typeof loadDetail !== 'function') return unknown();
  const seen = new Set([anidbId]); let current = anidbId, total = 0;
  for (let depth = 0; depth <= 4; depth++) {
    let relations;
    try { relations = depth === 0 && related ? related : await readRelatedTitles({ anidbId: current }); }
    catch { return unknown('provider_unavailable'); }
    if (providerUnavailable(relations)) return unknown('provider_unavailable');
    if (relations?.state !== 'related_titles' || relations.anidbId !== current ||
        !Array.isArray(relations.items) || relations.items.length > 50) return unknown();
    const prequels = relations.items.filter(x => x.relation?.toLowerCase() === 'prequel');
    if (!prequels.length) return total === offset ? { state: 'scope_confirmed', offset,
      basis: 'regular_prequel_chain', prequelIds: [...seen].slice(1) } : unknown();
    if (depth === 4 || prequels.length !== 1) return unknown();
    const id = prequels[0].anidbId;
    if (!Number.isSafeInteger(id) || id < 1 || seen.has(id)) return unknown();
    let detailProviderUnavailable = false;
    const detail = await collectAniDbDetail({ anidbId: id, loadPage: async input => {
      try {
        const result = await loadDetail(input);
        if (providerUnavailable(result)) detailProviderUnavailable = true;
        return result;
      } catch { detailProviderUnavailable = true; throw Error('Prequel provider unavailable'); }
    } });
    if (detail.state !== 'details' || detail.kind !== 'series') {
      return unknown(detailProviderUnavailable || providerUnavailable(detail) ? 'provider_unavailable' : undefined);
    }
    const regular = detail.episodes.filter(x => x.type === 'Episode').sort((a,b)=>a.number-b.number);
    if (!regular.length || !regular.every((x,i)=>x.number===i+1)) return unknown();
    total += regular.length;
    if (total > offset) return unknown();
    seen.add(id); current = id;
  }
  return unknown();
}
