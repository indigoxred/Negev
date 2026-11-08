const terminalReasons = new Set(['already_available', 'invalid_request',
  'idempotency_key_conflict', 'request_cancelled',
  'ambiguous_movie_scope']);

// One paced resolution attempt. The only way this worker creates an
// acquisition-visible request is through the existing exact submitter.
export function createPendingTitleWorker({ ledger, submitRequest,
  prepareDetail = async () => {}, now = Date.now } = {}) {
  if (typeof ledger?.claimDue !== 'function' ||
      typeof ledger.defer !== 'function' ||
      typeof ledger.finish !== 'function' ||
      typeof submitRequest !== 'function' ||
      typeof prepareDetail !== 'function' || typeof now !== 'function') {
    throw new TypeError('Invalid pending title worker');
  }
  return {
    async runOnce() {
      const startedMs = now();
      const claim = ledger.claimDue({ nowMs: startedMs, leaseMs: 300_000 });
      if (!claim) return { state: 'idle' };
      let result;
      try {
        result = await submitRequest({ requesterId: claim.requesterId,
          anidbId: claim.anidbId, scope: 'installment',
          requestKey: claim.requestKey });
      } catch { result = { state: 'held', reason: 'submit_unavailable' }; }
      if (result?.state === 'held' && Number.isSafeInteger(result.requestId) &&
          result.requestId > 0) {
        const saved = ledger.finish({ intentId: claim.id,
          version: claim.version, normalRequestId: result.requestId,
          nowMs: now() });
        return saved.state === 'resolved' ? { state: 'resolved', intentId: claim.id,
          requestId: result.requestId } : saved;
      }
      const reason = typeof result?.reason === 'string' &&
        result.reason.length <= 100 ? result.reason : 'submit_unavailable';
      if (terminalReasons.has(reason)) {
        return ledger.finish({ intentId: claim.id, version: claim.version,
          reason, nowMs: now() });
      }
      if (reason === 'detail_pending' || reason === 'detail_unavailable') {
        try { await prepareDetail({ anidbId: claim.anidbId }); }
        catch { /* The intent remains durable for a later retry. */ }
      }
      const delayMs = Math.min(600_000, 30_000 * 2 ** Math.min(10,
        claim.attempts));
      const deferred = ledger.defer({ intentId: claim.id,
        version: claim.version, nowMs: now(), delayMs, reason });
      return deferred.state === 'pending' ? { state: 'pending',
        intentId: claim.id, reason, nextDueMs: deferred.nextDueMs } : deferred;
    },
  };
}
