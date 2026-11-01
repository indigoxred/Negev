const validId = (value) => Number.isSafeInteger(value) && value > 0;
const held = () => ({ state: 'held', reason: 'import_quiet_window_unverified' });
const healthyFeed = (value) => value?.state === 'connected' &&
  Number.isSafeInteger(value.generation) && value.generation >= 0 &&
  value.pendingPaths === 0 && value.pendingEvents === 0 &&
  value.inFlight === false && value.reconciliationNeeded === false;

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

// This is a bounded observation for the explicit one-attempt first-acquisition
// policy, not proof that Shoko has settled or that a file is absent. A live
// adapter must derive connected/generation from the installed file feed and
// invalidate it on every file event, disconnect, overflow or reconnect.
export async function observeImportQuietWindow({ anidbId, episodeIds,
  readActivity, readFeedState, wait, now = Date.now,
  minQuietMs = 120_000, requireFingerprint = false } = {}) {
  if (!validId(anidbId) || !Array.isArray(episodeIds) ||
      episodeIds.length < 1 || episodeIds.length > 50 ||
      episodeIds.some((id) => !validId(id)) ||
      new Set(episodeIds).size !== episodeIds.length ||
      [readActivity, readFeedState, wait, now]
        .some((fn) => typeof fn !== 'function') ||
      typeof requireFingerprint !== 'boolean' ||
      !Number.isSafeInteger(minQuietMs) || minQuietMs < 60_000 ||
      minQuietMs > 300_000) {
    throw new TypeError('Invalid import quiet-window observation');
  }
  try {
    const beforeObservedAtMs = now();
    const beforeFeed = await readFeedState();
    if (!healthyFeed(beforeFeed)) return held();
    const beforeActivity = await readActivity({ anidbId,
      episodeIds: [...episodeIds] });
    if (beforeActivity?.state !== 'quiet_observed') return held();
    if (requireFingerprint &&
        !/^[0-9a-f]{64}$/.test(beforeActivity.fingerprint)) return held();
    await wait(minQuietMs);
    const afterActivity = await readActivity({ anidbId,
      episodeIds: [...episodeIds] });
    const afterFeed = await readFeedState();
    const afterObservedAtMs = now();
    if (afterActivity?.state !== 'quiet_observed' ||
        (requireFingerprint &&
          (afterActivity.fingerprint !== beforeActivity.fingerprint ||
           !/^[0-9a-f]{64}$/.test(afterActivity.fingerprint))) ||
        !healthyFeed(afterFeed) ||
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
      feedGeneration: afterFeed.generation };
  } catch { return held(); }
}
