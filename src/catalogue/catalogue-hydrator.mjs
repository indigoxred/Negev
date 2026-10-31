import { isCompleteAniDbDetail } from './hydration-ledger.mjs';
import { collectAniDbDetail } from './collect-detail.mjs';

// Isolated coordinator. Every external operation is injected; constructing it
// does not connect to Shoko or start an HTTP listener.
export function createCatalogueHydrator({ isKnownTitle, loadDetail, ledger, requestHydration, now = Date.now }) {
  if (typeof isKnownTitle !== 'function' || typeof loadDetail !== 'function' ||
      typeof ledger?.reserve !== 'function' || typeof ledger.finishLatestFromDetail !== 'function' ||
      typeof requestHydration !== 'function' || typeof now !== 'function') {
    throw new TypeError('Invalid catalogue hydration configuration');
  }

  return {
    async load({ anidbId }) {
      if (!Number.isSafeInteger(anidbId) || anidbId <= 0) {
        throw new TypeError('Invalid AniDB ID');
      }
      let known;
      try { known = await isKnownTitle({ anidbId }); }
      catch { return { state: 'held', reason: 'title_lookup_unavailable' }; }
      if (known !== true) return { state: 'held', reason: known === false ? 'unknown_title' : 'title_lookup_unavailable' };

      let detail;
      try { detail = await collectAniDbDetail({ anidbId, loadPage: loadDetail }); }
      catch { return { state: 'held', reason: 'detail_unavailable' }; }
      if (detail.state === 'partial_detail') return { state: 'pending', reason: 'detail_pagination_required' };
      if (detail.state === 'invalid_detail_evidence') return { state: 'held', reason: 'invalid_detail_evidence' };
      if (detail?.state === 'details') {
        if (detail.anidbId !== anidbId) return { state: 'held', reason: 'invalid_detail_evidence' };
        if (detail.complete !== true) return { state: 'pending', reason: 'detail_pagination_required' };
        if (!isCompleteAniDbDetail(detail, anidbId)) return { state: 'held', reason: 'invalid_detail_evidence' };
        const finished = ledger.finishLatestFromDetail(anidbId, detail, now());
        if (finished.state === 'held') return finished;
        return { state: 'detail_ready', detail, requestable: false };
      }
      if (detail?.state !== 'detail_pending' || detail.anidbId !== anidbId) {
        return { state: 'held', reason: 'detail_unavailable' };
      }

      const claim = ledger.reserve({ anidbId, titleKnown: true, detailState: 'detail_pending', nowMs: now() });
      if (claim.state !== 'reserved') return { state: 'pending', reason: claim.reason };
      let submitted;
      try { submitted = await requestHydration({ anidbId }); }
      catch { submitted = { state: 'unavailable' }; }
      if (submitted?.state === 'queued' || submitted?.state === 'refresh_accepted') {
        return { state: 'pending', reason: 'refresh_queued', claimId: claim.claimId };
      }
      return { state: 'held', reason: 'refresh_unavailable', claimId: claim.claimId };
    },
  };
}
