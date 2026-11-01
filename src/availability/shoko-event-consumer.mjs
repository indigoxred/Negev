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
// The installed feed can join; delivery of a genuine file event still needs
// a controlled live proof.
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
  const forgetPathResolutions = (key) => {
    for (const [fileId, resolution] of resolutions) {
      if (resolution.key === key) resolutions.delete(fileId);
    }
  };
  let detectionSequence = 0;
  let generation = 0;
  let inFlight = null;
  let pump = null;
  let reconciliationNeeded = false;
  let fullReconciliationNeeded = false;
  let pendingOnlyDebt = false;
  let stopping = false;
  const bumpGeneration = () => {
    if (generation < Number.MAX_SAFE_INTEGER) generation++;
    else { reconciliationNeeded = true; fullReconciliationNeeded = true;
      pendingOnlyDebt = false; }
  };

  const acknowledgeLinkedObservation = ({ fileId, token, result } = {}) => {
    if (!validId(fileId) || !token ||
        result?.state !== 'recorded_file' || result.recognition !== 'linked' ||
        resolutions.get(fileId) !== token ||
        detected.get(token.key) !== token.sequence) return { state: 'held' };
    detected.delete(token.key);
    resolutions.delete(fileId);
    // A resolved path still owes a later catch-up, so remaining paths alone
    // no longer explain the dirty generation.
    pendingOnlyDebt = false;
    return { state: 'resolved' };
  };

  const flagUnresolvedEvent = (fileId) => {
    bumpGeneration();
    reconciliationNeeded = true;
    fullReconciliationNeeded = true;
    pendingOnlyDebt = false;
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
        try {
          const result = await refreshFile(fileId);
          if (result?.state !== 'recorded_file') flagUnresolvedEvent(fileId);
          else if (resolution) acknowledgeLinkedObservation({
            fileId, token: resolution, result });
        } catch { flagUnresolvedEvent(fileId); }
        inFlight = null;
      }
    })().finally(() => {
      pump = null;
      if (pending.size) drain();
    });
  };

  return {
    // Capture before a separate Shoko GET. A newer detection or hash changes
    // the token, so its stale response cannot clear the pending path.
    snapshotPendingResolution(fileId) {
      return validId(fileId) && !stopping ? resolutions.get(fileId) ?? null : null;
    },
    acknowledgeLinkedObservation,
    accept(target, args) {
      if (stopping) return { state: 'held', reason: 'consumer_stopping' };
      if (target === 'file:detected' || idEvents.has(target)) bumpGeneration();
      if (target === 'file:detected') {
        if (!reconciliationNeeded && !fullReconciliationNeeded &&
            detected.size === 0) pendingOnlyDebt = true;
        reconciliationNeeded = true;
        const key = Array.isArray(args) && args.length === 1
          ? arrivalKey(args[0]) : null;
        if (!key) { fullReconciliationNeeded = true; pendingOnlyDebt = false; }
        if (key && (detected.has(key) || detected.size < maxArrivals)) {
          forgetPathResolutions(key);
          detected.set(key, ++detectionSequence);
        } else if (key) {
          // A dropped path may not have a FileID yet. A recent-file scan
          // cannot account for it, even after every tracked path resolves.
          fullReconciliationNeeded = true;
          pendingOnlyDebt = false;
        }
        return { state: 'reconcile', reason: 'file_detected' };
      }
      if (!idEvents.has(target)) return { state: 'ignored' };
      const fileId = Array.isArray(args) && args.length === 1 ? args[0]?.FileID : null;
      if (!validId(fileId)) {
        reconciliationNeeded = true;
        fullReconciliationNeeded = true;
        pendingOnlyDebt = false;
        return { state: 'reconcile', reason: 'invalid_event' };
      }
      if (target === 'file:deleted') {
        reconciliationNeeded = true;
        fullReconciliationNeeded = true;
        pendingOnlyDebt = false;
        try { onDeleted?.(fileId); }
        catch { flagUnresolvedEvent(fileId); }
      }
      const alreadyQueued = pending.has(fileId);
      if (!alreadyQueued && pending.size >= maxPending) {
        reconciliationNeeded = true;
        fullReconciliationNeeded = true;
        pendingOnlyDebt = false;
        return { state: 'reconcile', reason: 'event_overflow' };
      }
      if (target === 'file:hashed') {
        const key = arrivalKey(args[0]);
        if (key && detected.has(key)) {
          forgetPathResolutions(key);
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
        reconciliationNeeded, fullReconciliationNeeded, generation };
    },
    // Internal-only atomic snapshot. Pending keys never leave the account
    // service and cannot by themselves authorize an acquisition.
    getPendingSnapshot() {
      return { state: stopping ? 'stopping' : 'snapshot', generation,
        pending: pending.size, inFlight, reconciliationNeeded,
        fullReconciliationNeeded, pendingOnlyDebt,
        pendingKeys: [...detected.keys()].sort() };
    },
    // Only a completed catch-up that started at this exact event generation
    // may clear the dirty bit. Pending paths and reads still block clearance.
    acknowledgeReconciliation(expectedGeneration) {
      if (stopping || !Number.isSafeInteger(expectedGeneration) ||
          expectedGeneration !== generation ||
          generation === Number.MAX_SAFE_INTEGER || pending.size ||
          inFlight !== null || detected.size || resolutions.size ||
          fullReconciliationNeeded) {
        return { state: 'held' };
      }
      reconciliationNeeded = false;
      pendingOnlyDebt = false;
      return { state: 'acknowledged' };
    },
    // Reserved for a complete inventory catch-up. A recent-file page alone
    // cannot repair a feed gap or an invalid/deleted event.
    acknowledgeFullReconciliation(expectedGeneration) {
      if (stopping || !Number.isSafeInteger(expectedGeneration) ||
          expectedGeneration !== generation ||
          generation === Number.MAX_SAFE_INTEGER || pending.size ||
          inFlight !== null || detected.size || resolutions.size) {
        return { state: 'held' };
      }
      fullReconciliationNeeded = false;
      reconciliationNeeded = false;
      pendingOnlyDebt = false;
      return { state: 'acknowledged' };
    },
    // Positive busy evidence only. Empty memory cannot prove that Shoko's
    // watcher, hash queue, or a disconnected event feed has settled.
    getArrivalState() {
      return { state: detected.size ? 'busy' : 'unverified',
        pendingPaths: detected.size };
    },
    flagReconciliation() {
      bumpGeneration(); reconciliationNeeded = true;
      fullReconciliationNeeded = true;
      pendingOnlyDebt = false;
    },
    async close() {
      stopping = true;
      pendingOnlyDebt = false;
      if (pump) await pump;
    },
  };
}
