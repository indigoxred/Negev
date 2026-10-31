const validId = (value) => Number.isSafeInteger(value) && value > 0;
const idEvents = new Set(['file:hashed', 'file:relocated',
  'file:deleted', 'file:updated']);

// Accepts decoded SignalR hub method calls, not untrusted raw WebSocket frames.
// The installed feed subscription and authentication still need live proof.
export function createShokoEventConsumer({ refreshFile, maxPending = 64 } = {}) {
  if (typeof refreshFile !== 'function' || !Number.isSafeInteger(maxPending) ||
      maxPending < 1 || maxPending > 256) {
    throw new TypeError('Invalid Shoko event consumer');
  }
  const pending = new Set();
  let inFlight = null;
  let pump = null;
  let reconciliationNeeded = false;
  let stopping = false;

  const drain = () => {
    if (pump) return;
    pump = (async () => {
      while (pending.size) {
        const fileId = pending.values().next().value;
        pending.delete(fileId);
        inFlight = fileId;
        try {
          const result = await refreshFile(fileId);
          if (result?.state !== 'recorded_file') reconciliationNeeded = true;
        } catch { reconciliationNeeded = true; }
        inFlight = null;
      }
    })().finally(() => {
      pump = null;
      if (pending.size) drain();
    });
  };

  return {
    accept(target, args) {
      if (stopping) return { state: 'held', reason: 'consumer_stopping' };
      if (target === 'file:detected') {
        reconciliationNeeded = true;
        return { state: 'reconcile', reason: 'file_detected' };
      }
      if (!idEvents.has(target)) return { state: 'ignored' };
      const fileId = Array.isArray(args) && args.length === 1 ? args[0]?.FileID : null;
      if (!validId(fileId)) {
        reconciliationNeeded = true;
        return { state: 'reconcile', reason: 'invalid_event' };
      }
      if (target === 'file:deleted') reconciliationNeeded = true;
      if (pending.has(fileId)) return { state: 'coalesced', fileId };
      if (pending.size >= maxPending) {
        reconciliationNeeded = true;
        return { state: 'reconcile', reason: 'event_overflow' };
      }
      // A second event during an active GET needs another GET. Coalescing it
      // into the active read could permanently miss a later Shoko state.
      const alreadyReading = inFlight === fileId;
      pending.add(fileId);
      drain();
      return { state: alreadyReading ? 'coalesced' : 'queued', fileId };
    },
    getState() {
      return { pending: pending.size, inFlight,
        reconciliationNeeded };
    },
    flagReconciliation() { reconciliationNeeded = true; },
    async close() {
      stopping = true;
      if (pump) await pump;
    },
  };
}
