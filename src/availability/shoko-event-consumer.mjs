const validId = (value) => Number.isSafeInteger(value) && value > 0;
const idEvents = new Set(['file:hashed', 'file:relocated',
  'file:deleted', 'file:updated']);
const arrivalKey = (event) => {
  const rawName = event?.RelativePath;
  // Shoko 6 emits managed-folder-relative paths with one root slash.
  // Canonicalize that prefix only; repeated slashes and unsafe segments
  // still fail the checks below, and the managed folder remains in the key.
  const name = typeof rawName === 'string' && rawName.startsWith('/')
    ? rawName.slice(1) : rawName;
  if (!validId(event?.ManagedFolderID) || typeof name !== 'string' ||
      !name || rawName.length > 2048 || name.startsWith('/') ||
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
      typeof consumer?.getState !== 'function' ||
      typeof requestReconciliation !== 'function') {
    throw new TypeError('Invalid Shoko event forwarding');
  }
  const fullBefore = consumer.getState().fullReconciliationNeeded === true;
  const result = consumer.accept(target, args);
  if (result.state === 'reconcile') requestReconciliation(result,
    !fullBefore && consumer.getState().fullReconciliationNeeded === true);
  return result;
}

// Accepts decoded SignalR hub method calls, not untrusted raw WebSocket frames.
// The installed feed can join; delivery of a genuine file event still needs
// a controlled live proof.
export function createShokoEventConsumer({ refreshFile, onDeleted, onFileEvent,
  onReconciliationNeeded, intakeFolderIds,
  maxPending = 64, maxArrivals = 128 } = {}) {
  if (typeof refreshFile !== 'function' || !Number.isSafeInteger(maxPending) ||
      maxPending < 1 || maxPending > 256 ||
      !Number.isSafeInteger(maxArrivals) || maxArrivals < 1 ||
      maxArrivals > 1024 ||
      (intakeFolderIds !== undefined && (!Array.isArray(intakeFolderIds) ||
        intakeFolderIds.length < 1 || intakeFolderIds.some(id => !validId(id)) ||
        new Set(intakeFolderIds).size !== intakeFolderIds.length)) ||
      (onDeleted !== undefined && typeof onDeleted !== 'function') ||
      (onFileEvent !== undefined && typeof onFileEvent !== 'function') ||
      (onReconciliationNeeded !== undefined &&
        typeof onReconciliationNeeded !== 'function')) {
    throw new TypeError('Invalid Shoko event consumer');
  }
  const pending = new Set();
  const detected = new Map();
  const resolutions = new Map();
  const intake = intakeFolderIds === undefined ? null : new Set(intakeFolderIds);
  const isIntakeKey = key => intake === null || intake.has(Number(key.split(':', 1)[0]));
  const intakeKeys = () => [...detected.keys()].filter(isIntakeKey);
  const unknownCount = () => detected.size - intakeKeys().length;
  let unknownOverflow = false;
  let unknownReconciliationNeeded = false;
  const unknownEvidence = () => intake === null ? {} : {
    unknownPendingPaths: unknownCount(), unknownPathOverflow: unknownOverflow };
  const blockingPaths = () => intakeKeys().length > 0 ||
    [...resolutions.values()].some(token => isIntakeKey(token.key));
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
    const fullBefore = fullReconciliationNeeded;
    bumpGeneration();
    reconciliationNeeded = true;
    fullReconciliationNeeded = true;
    pendingOnlyDebt = false;
    try { onReconciliationNeeded?.(fileId, !fullBefore); }
    catch { /* Keep draining. */ }
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
    snapshotPendingPathResolutions() {
      return stopping ? [] : [...detected].map(([key,sequence])=>({key,sequence}));
    },
    acknowledgeLinkedPathObservation({token,fileId,path,result}={}) {
      if(stopping||!validId(fileId)||!token||arrivalKey(path)!==token.key||
          detected.get(token.key)!==token.sequence||result?.state!=='recorded_file'||
          result.recognition!=='linked')return {state:'held'};
      detected.delete(token.key);forgetPathResolutions(token.key);
      pendingOnlyDebt=false;return {state:'resolved'};
    },
    // Only the same event generation's complete, twice observed watched-root
    // inventory may retire a detected path that has since moved or vanished.
    // This clears path debt, never creates a linked file or an absence proof.
    acknowledgeMissingPathObservations({tokens,generation:expected,managedFolderId,observation}={}) {
      if(stopping||expected!==generation||!validId(managedFolderId)||!Array.isArray(tokens)||
          observation?.state!=='quiet_observed'||!/^[a-f0-9]{64}$/.test(observation.fingerprint)||
          !Array.isArray(observation.observedPathKeys))return {state:'held'};
      const present=new Set(observation.observedPathKeys);let resolved=0;
      for(const token of tokens)if(token.key.startsWith(managedFolderId+':')&&
          detected.get(token.key)===token.sequence&&!present.has(token.key)){
        detected.delete(token.key);forgetPathResolutions(token.key);resolved++;
      }
      if(resolved)pendingOnlyDebt=false;
      return {state:'observed',resolved};
    },
    accept(target, args) {
      if (stopping) return { state: 'held', reason: 'consumer_stopping' };
      if (target === 'file:detected' || idEvents.has(target)) bumpGeneration();
      if (target === 'file:detected') {
        if (!reconciliationNeeded && !fullReconciliationNeeded &&
            intakeKeys().length === 0) pendingOnlyDebt = true;
        reconciliationNeeded = true;
        const key = Array.isArray(args) && args.length === 1
          ? arrivalKey(args[0]) : null;
        if (!key) { fullReconciliationNeeded = true; pendingOnlyDebt = false; }
        // Unconfigured folder detections remain explicit evidence, but cannot
        // consume the configured intake's path budget or permanently block it.
        // They still dirty the global catalogue and require full catch-up.
        const unknown = key !== null && !isIntakeKey(key);
        if (unknown) {
          unknownReconciliationNeeded = true;
          fullReconciliationNeeded = true; pendingOnlyDebt = false;
        }
        const categoryCount = unknown ? unknownCount() : intakeKeys().length;
        if (key && (detected.has(key) || categoryCount < maxArrivals)) {
          forgetPathResolutions(key);
          detected.set(key, ++detectionSequence);
        } else if (key) {
          if (unknown) unknownOverflow = true;
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
      } else {
        try { onFileEvent?.(fileId); }
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
        reconciliationNeeded, fullReconciliationNeeded, generation,
        ...unknownEvidence() };
    },
    // Internal-only atomic snapshot. Pending keys never leave the account
    // service and cannot by themselves authorize an acquisition.
    getPendingSnapshot() {
      // The first-attempt policy may tolerate ordinary startup debt, but
      // cannot skip the full catch-up caused by an unobserved source event.
      const unknownCatchup = unknownReconciliationNeeded;
      return { state: stopping ? 'stopping' : unknownCatchup ? 'unverified' : 'snapshot', generation,
        pending: pending.size, inFlight, reconciliationNeeded,
        fullReconciliationNeeded, pendingOnlyDebt,
        pendingKeys: intakeKeys().sort(), ...unknownEvidence() };
    },
    // Only a completed catch-up that started at this exact event generation
    // may clear the dirty bit. Pending paths and reads still block clearance.
    acknowledgeReconciliation(expectedGeneration) {
      if (stopping || !Number.isSafeInteger(expectedGeneration) ||
          expectedGeneration !== generation ||
          generation === Number.MAX_SAFE_INTEGER || pending.size ||
          inFlight !== null || blockingPaths() ||
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
          inFlight !== null || blockingPaths()) {
        return { state: 'held' };
      }
      fullReconciliationNeeded = false;
      unknownReconciliationNeeded = false;
      reconciliationNeeded = false;
      pendingOnlyDebt = false;
      return { state: 'acknowledged' };
    },
    // Positive busy evidence only. Empty memory cannot prove that Shoko's
    // watcher, hash queue, or a disconnected event feed has settled.
    getArrivalState() {
      const pendingPaths = intakeKeys().length;
      return { state: pendingPaths ? 'busy' : 'unverified',
        pendingPaths, ...unknownEvidence() };
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
