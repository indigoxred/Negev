// A feed gap needs a full inventory catch-up, not a recent-file scan. Keep
// pass proofs in memory so restart and half-finished saved cursors fail closed.
export function createShokoFullReconciliation({ ledger, consumer,
  readConnectionState, tickPage } = {}) {
  if (typeof ledger?.getCursor !== 'function' ||
      typeof ledger?.getCompletedPass !== 'function' ||
      typeof consumer?.getState !== 'function' ||
      typeof consumer?.acknowledgeFullReconciliation !== 'function' ||
      typeof readConnectionState !== 'function' ||
      typeof tickPage !== 'function') {
    throw new TypeError('Invalid Shoko full reconciliation');
  }
  let active = null;
  let prior = null;
  const connected = () => {
    try { return readConnectionState()?.state === 'connected'; }
    catch { return false; }
  };
  return {
    async tick() {
      const cursor = ledger.getCursor();
      const before = consumer.getState();
      if (cursor.page === 1 && active?.pass !== cursor.pass) {
        active = before.fullReconciliationNeeded && connected() ?
          { pass: cursor.pass, generation: before.generation } : null;
      }
      let result;
      try { result = await tickPage(); }
      catch (error) {
        active = null;
        prior = null;
        throw error;
      }
      const after = consumer.getState();
      if (!connected() || !after.fullReconciliationNeeded ||
          active?.generation !== after.generation) {
        active = null;
        prior = null;
      }
      if (result?.state !== 'recorded') {
        if (result?.state === 'held') { active = null; prior = null; }
        return result;
      }
      if (result.nextPage !== 1) return result;
      const complete = active?.pass === result.pass ?
        ledger.getCompletedPass(result.pass) : null;
      active = null;
      if (!after.fullReconciliationNeeded) return result;
      if (!complete) {
        prior = null;
        return { state: 'held', reason: 'full_reconciliation_pending' };
      }
      if (prior?.generation === after.generation &&
          prior.pass === complete.pass - 1 &&
          prior.total === complete.total && prior.digest === complete.digest &&
          consumer.acknowledgeFullReconciliation(after.generation).state ===
            'acknowledged') {
        prior = null;
        return result;
      }
      prior = { ...complete, generation: after.generation };
      return { state: 'held', reason: 'full_reconciliation_pending' };
    },
  };
}
