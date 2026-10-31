const validId = (value) => Number.isSafeInteger(value) && value > 0;
const idEvents = new Set(['file:hashed', 'file:relocated',
  'file:deleted', 'file:updated']);
const arrivalKey = (event) => {
  const name = event?.RelativePath;
  if (!validId(event?.ManagedFolderID) || typeof name !== 'string' ||
      !name || name.length > 2048 || name.startsWith('/') ||
      /[\\\0\r\n]/.test(name) ||
      name.split('/').some((part) => !part || part === '.' || part === '..')) {
    return null;
  }
  return `${event.ManagedFolderID}:${name}`;
};

// Targeted file-ID events already cause an exact refresh. Only events that
// cannot be resolved by that refresh wake the broad inventory backfill.
export function forwardShokoEvent({ consumer, requestReconciliation,
  target, args } = {}) {
  if (typeof consumer?.accept !== 'function' ||
      typeof requestReconciliation !== 'function') {
    throw new TypeError('Invalid Shoko event forwarding');
  }
  const result = consumer.accept(target, args);
  if (result.state === 'reconcile') requestReconciliation();
  return result;
}

// Accepts decoded SignalR hub method calls, not untrusted raw WebSocket frames.
// The installed feed subscription and authentication still need live proof.
export function createShokoEventConsumer({ refreshFile, onDeleted,
  onReconciliationNeeded,
  maxPending = 64, maxArrivals = 128 } = {}) {
  if (typeof refreshFile !== 'function' || !Number.isSafeInteger(maxPending) ||
      maxPending < 1 || maxPending > 256 ||
      !Number.isSafeInteger(maxArrivals) || maxArrivals < 1 ||
      maxArrivals > 1024 ||
      (onDeleted !== undefined && typeof onDeleted !== 'function') ||
      (onReconciliationNeeded !== undefined &&
        typeof onReconciliationNeeded !== 'function')) {
    throw new TypeError('Invalid Shoko event consumer');
  }
  const pending = new Set();
  const detected = new Map();
  const resolutions = new Map();
  let detectionSequence = 0;
  let inFlight = null;
  let pump = null;
  let reconciliationNeeded = false;
  let stopping = false;

  const flagUnresolvedEvent = (fileId) => {
    reconciliationNeeded = true;
    try { onReconciliationNeeded?.(fileId); } catch { /* Keep draining. */ }
  };

  const drain = () => {
    if (pump) return;
    pump = (async () => {
      while (pending.size) {
        const fileId = pending.values().next().value;
        pending.delete(fileId);
        inFlight = fileId;
        const resolution = resolutions.get(fileId);
        resolutions.delete(fileId);
        try {
          const result = await refreshFile(fileId);
          if (result?.state !== 'recorded_file') flagUnresolvedEvent(fileId);
          else if (resolution &&
              detected.get(resolution.key) === resolution.sequence) {
            detected.delete(resolution.key);
          }
        } catch { flagUnresolvedEvent(fileId); }
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
        const key = Array.isArray(args) && args.length === 1
          ? arrivalKey(args[0]) : null;
        if (key && (detected.has(key) || detected.size < maxArrivals)) {
          detected.set(key, ++detectionSequence);
        }
        return { state: 'reconcile', reason: 'file_detected' };
      }
      if (!idEvents.has(target)) return { state: 'ignored' };
      const fileId = Array.isArray(args) && args.length === 1 ? args[0]?.FileID : null;
      if (!validId(fileId)) {
        reconciliationNeeded = true;
        return { state: 'reconcile', reason: 'invalid_event' };
      }
      if (target === 'file:deleted') {
        reconciliationNeeded = true;
        try { onDeleted?.(fileId); }
        catch { flagUnresolvedEvent(fileId); }
      }
      const alreadyQueued = pending.has(fileId);
      if (!alreadyQueued && pending.size >= maxPending) {
        reconciliationNeeded = true;
        return { state: 'reconcile', reason: 'event_overflow' };
      }
      if (target === 'file:hashed') {
        const key = arrivalKey(args[0]);
        if (key && detected.has(key)) {
          resolutions.set(fileId, { key, sequence: detected.get(key) });
        }
      }
      if (alreadyQueued) return { state: 'coalesced', fileId };
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
    // Positive busy evidence only. Empty memory cannot prove that Shoko's
    // watcher, hash queue, or a disconnected event feed has settled.
    getArrivalState() {
      return { state: detected.size ? 'busy' : 'unverified',
        pendingPaths: detected.size };
    },
    flagReconciliation() { reconciliationNeeded = true; },
    async close() {
      stopping = true;
      if (pump) await pump;
    },
  };
}
