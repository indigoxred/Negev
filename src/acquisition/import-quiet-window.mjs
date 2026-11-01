const validId = (value) => Number.isSafeInteger(value) && value > 0;
const held = () => ({ state: 'held', reason: 'import_quiet_window_unverified' });
const healthyFeed = (value) => value?.state === 'connected' &&
  Number.isSafeInteger(value.generation) && value.generation >= 0 &&
  value.pendingPaths === 0 && value.pendingEvents === 0 &&
  value.inFlight === false && value.reconciliationNeeded === false;
const healthyScopedFeed = (value, keys) => keys.length === 0 ?
  healthyFeed(value) : value?.state === 'connected_scoped' &&
  Number.isSafeInteger(value.generation) && value.generation >= 0 &&
  value.pendingPaths === keys.length && value.pendingEvents === 0 &&
  value.inFlight === false && value.reconciliationNeeded === true &&
  value.pendingOnlyDebt === true;
const validActivityKeys = (value) => Array.isArray(value) &&
  value.length <= 128 && value.every(validPendingKey) &&
  new Set(value).size === value.length;

// Bind the actual SignalR connection to the consumer's generation and
// unresolved paths. Any gap or full-reconciliation debt remains unverified.
export function importFeedState({ connection, event, arrival } = {}) {
  if (connection?.state !== 'connected') return { state: 'disconnected' };
  if (!Number.isSafeInteger(event?.generation) || event.generation < 0 ||
      event.pending !== 0 ||
      event.inFlight !== null || event.reconciliationNeeded !== false ||
      event.fullReconciliationNeeded !== false ||
      arrival?.state !== 'unverified' ||
      !Number.isSafeInteger(arrival.pendingPaths) ||
      arrival.pendingPaths !== 0) return { state: 'unverified' };
  return { state: 'connected', generation: event.generation,
    pendingPaths: 0, pendingEvents: 0, inFlight: false,
    reconciliationNeeded: false };
}

export const validPendingKey = (value) => {
  if (typeof value !== 'string' || value.length > 2_160 ||
      /[\\\x00-\x1f\x7f]/.test(value)) return false;
  const match = /^([1-9][0-9]*):(.+)$/.exec(value);
  const folderId = Number(match?.[1]);
  return Number.isSafeInteger(folderId) &&
    match[2].length <= 2_048 && !match[2].startsWith('/') &&
    match[2].split('/').every((part) => part && part !== '.' && part !== '..');
};

// This returns no paths. A pending-only event snapshot becomes scoped only
// when every actual key exactly equals a caller-supplied, separately proven
// Negev handoff path. Earlier reconciliation debt and gaps remain unverified.
export function scopedImportFeedState({ connection, snapshot,
  allowedPendingKeys } = {}) {
  if (connection?.state !== 'connected') return { state: 'disconnected' };
  if (snapshot?.state !== 'snapshot' ||
      !Number.isSafeInteger(snapshot.generation) || snapshot.generation < 0 ||
      snapshot.pending !== 0 || snapshot.inFlight !== null ||
      snapshot.fullReconciliationNeeded !== false ||
      !Array.isArray(snapshot.pendingKeys) ||
      snapshot.pendingKeys.length > 128 ||
      snapshot.pendingKeys.some((key) => !validPendingKey(key)) ||
      new Set(snapshot.pendingKeys).size !== snapshot.pendingKeys.length ||
      (allowedPendingKeys !== undefined &&
        (!Array.isArray(allowedPendingKeys) ||
         allowedPendingKeys.length > 128 ||
         allowedPendingKeys.some((key) => !validPendingKey(key)) ||
         new Set(allowedPendingKeys).size !== allowedPendingKeys.length))) {
    return { state: 'unverified' };
  }
  const count = snapshot.pendingKeys.length;
  if (count === 0) {
    if (snapshot.reconciliationNeeded !== false ||
        snapshot.pendingOnlyDebt !== false ||
        allowedPendingKeys?.length) return { state: 'unverified' };
    return { state: 'connected', generation: snapshot.generation,
      pendingPaths: 0, pendingEvents: 0, inFlight: false,
      reconciliationNeeded: false };
  }
  if (snapshot.reconciliationNeeded !== true ||
      snapshot.pendingOnlyDebt !== true) return { state: 'unverified' };
  if (allowedPendingKeys === undefined) return { state: 'pending_unverified',
    generation: snapshot.generation, pendingPaths: count };
  if (count !== allowedPendingKeys.length ||
      JSON.stringify([...snapshot.pendingKeys].sort()) !==
      JSON.stringify([...allowedPendingKeys].sort())) return { state: 'unverified' };
  return { state: 'connected_scoped', generation: snapshot.generation,
    pendingPaths: count, pendingEvents: 0, inFlight: false,
    reconciliationNeeded: true, pendingOnlyDebt: true };
}

// This is a bounded observation for the explicit one-attempt first-acquisition
// policy, not proof that Shoko has settled or that a file is absent. A live
// adapter must derive connected/generation from the installed file feed and
// invalidate it on every file event, disconnect, overflow or reconnect.
export async function observeImportQuietWindow({ anidbId, episodeIds,
  readActivity, readFeedState, readScopedFeedState, wait, now = Date.now,
  minQuietMs = 120_000, requireFingerprint = false } = {}) {
  if (!validId(anidbId) || !Array.isArray(episodeIds) ||
      episodeIds.length < 1 || episodeIds.length > 50 ||
      episodeIds.some((id) => !validId(id)) ||
      new Set(episodeIds).size !== episodeIds.length ||
      [readActivity, readFeedState, wait, now]
        .some((fn) => typeof fn !== 'function') ||
      (readScopedFeedState !== undefined &&
        typeof readScopedFeedState !== 'function') ||
      typeof requireFingerprint !== 'boolean' ||
      !Number.isSafeInteger(minQuietMs) || minQuietMs < 60_000 ||
      minQuietMs > 300_000) {
    throw new TypeError('Invalid import quiet-window observation');
  }
  try {
    const beforeObservedAtMs = now();
    const initialFeed = await (readScopedFeedState ?
      readScopedFeedState() : readFeedState());
    if (readScopedFeedState ?
      !['connected', 'pending_unverified'].includes(initialFeed?.state) :
      !healthyFeed(initialFeed)) return held();
    const beforeActivity = await readActivity({ anidbId,
      episodeIds: [...episodeIds] });
    if (beforeActivity?.state !== 'quiet_observed') return held();
    if (requireFingerprint &&
        !/^[0-9a-f]{64}$/.test(beforeActivity.fingerprint)) return held();
    const keys = readScopedFeedState ? beforeActivity.unrelatedPendingKeys : [];
    if (readScopedFeedState && !validActivityKeys(keys)) return held();
    const beforeFeed = readScopedFeedState ?
      await readScopedFeedState(keys) : initialFeed;
    if (readScopedFeedState &&
        (!healthyScopedFeed(beforeFeed, keys) ||
         beforeFeed.generation !== initialFeed.generation ||
         beforeFeed.pendingPaths !== initialFeed.pendingPaths)) return held();
    await wait(minQuietMs);
    const afterActivity = await readActivity({ anidbId,
      episodeIds: [...episodeIds] });
    const afterFeed = await (readScopedFeedState ?
      readScopedFeedState(keys) : readFeedState());
    const afterObservedAtMs = now();
    if (afterActivity?.state !== 'quiet_observed' ||
        (requireFingerprint &&
          (afterActivity.fingerprint !== beforeActivity.fingerprint ||
           !/^[0-9a-f]{64}$/.test(afterActivity.fingerprint))) ||
        (readScopedFeedState &&
          (!validActivityKeys(afterActivity.unrelatedPendingKeys) ||
           JSON.stringify([...afterActivity.unrelatedPendingKeys].sort()) !==
             JSON.stringify([...keys].sort()))) ||
        !(readScopedFeedState ? healthyScopedFeed(afterFeed, keys) :
          healthyFeed(afterFeed)) ||
        beforeFeed.generation !== afterFeed.generation ||
        !Number.isSafeInteger(beforeObservedAtMs) ||
        !Number.isSafeInteger(afterObservedAtMs) ||
        beforeObservedAtMs < 0 ||
        afterObservedAtMs - beforeObservedAtMs < minQuietMs ||
        afterObservedAtMs - beforeObservedAtMs > minQuietMs + 30_000) {
      return held();
    }
    return { state: 'quiet_window_observed', anidbId,
      episodeIds: [...episodeIds], beforeObservedAtMs, afterObservedAtMs,
      feedGeneration: afterFeed.generation,
      ...(readScopedFeedState ? { unrelatedPendingKeys: keys } : {}) };
  } catch { return held(); }
}
