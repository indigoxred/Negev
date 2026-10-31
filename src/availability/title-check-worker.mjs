// One explicit tick performs one bounded metadata page read or one exact
// public availability observation. Scheduling and NAS load limits belong to
// the caller; this worker never triggers a Shoko refresh or an acquisition.
export function createTitleCheckWorker({ ledger, loadDetail, observeTarget,
  now = Date.now } = {}) {
  if (typeof ledger?.claimNext !== 'function' ||
      typeof ledger?.recordPage !== 'function' ||
      typeof ledger?.recordTarget !== 'function' ||
      typeof ledger?.defer !== 'function' ||
      typeof loadDetail !== 'function' ||
      typeof observeTarget !== 'function' || typeof now !== 'function') {
    throw new TypeError('Invalid title-check worker');
  }
  let busy = false;
  return {
    async runOnce() {
      if (busy) return { state: 'held', reason: 'check_in_progress' };
      busy = true;
      try {
        const receipt = ledger.claimNext({ nowMs: now() });
        if (receipt.state === 'idle') return receipt;
        if (receipt.state === 'claimed_page') {
          let detail;
          try { detail = await loadDetail({ anidbId: receipt.anidbId,
            page: receipt.page }); }
          catch { detail = { state: 'unavailable' }; }
          if (detail?.state !== 'details') {
            const deferred = ledger.defer({ claim: receipt,
              retryAtMs: now() + 5 * 60_000 });
            return deferred.state === 'deferred'
              ? { state: 'deferred', reason: 'catalogue_unavailable' } : deferred;
          }
          const saved = ledger.recordPage({ claim: receipt, detail,
            checkedMs: now() });
          return saved.state === 'recorded_page'
            ? { state: 'page_loaded', anidbId: receipt.anidbId,
              page: receipt.page } : saved;
        }
        if (receipt.state === 'claimed_target') {
          let result;
          try { result = await observeTarget({ anidbId: receipt.anidbId,
            episodeId: receipt.episodeId, kind: receipt.kind }); }
          catch {
            const deferred = ledger.defer({ claim: receipt,
              retryAtMs: now() + 5 * 60_000 });
            return deferred.state === 'deferred'
              ? { state: 'deferred', reason: 'observer_unavailable' } : deferred;
          }
          const status = result?.state === 'available' ? 'available' : 'unknown';
          const saved = ledger.recordTarget({ claim: receipt, status,
            checkedMs: now() });
          return saved.state === 'recorded_target'
            ? { state: 'target_checked', anidbId: receipt.anidbId,
              episodeId: receipt.episodeId, result: status } : saved;
        }
        return { state: 'held', reason: 'invalid_claim' };
      } finally { busy = false; }
    },
  };
}
