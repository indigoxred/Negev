const validId = (value) => Number.isSafeInteger(value) && value > 0;
const held = () => ({ state: 'held', reason: 'import_quiet_window_unverified' });
const healthyFeed = (value) => value?.state === 'connected' &&
  Number.isSafeInteger(value.generation) && value.generation >= 0 &&
  value.pendingPaths === 0 && value.pendingEvents === 0 &&
  value.inFlight === false && value.reconciliationNeeded === false;

// This is a bounded observation for the explicit one-attempt first-acquisition
// policy, not proof that Shoko has settled or that a file is absent. A live
// adapter must derive connected/generation from the installed file feed and
// invalidate it on every file event, disconnect, overflow or reconnect.
export async function observeImportQuietWindow({ anidbId, episodeIds,
  readActivity, readFeedState, wait, now = Date.now,
  minQuietMs = 120_000 } = {}) {
  if (!validId(anidbId) || !Array.isArray(episodeIds) ||
      episodeIds.length < 1 || episodeIds.length > 50 ||
      episodeIds.some((id) => !validId(id)) ||
      new Set(episodeIds).size !== episodeIds.length ||
      [readActivity, readFeedState, wait, now]
        .some((fn) => typeof fn !== 'function') ||
      !Number.isSafeInteger(minQuietMs) || minQuietMs < 60_000 ||
      minQuietMs > 300_000) {
    throw new TypeError('Invalid import quiet-window observation');
  }
  try {
    const beforeObservedAtMs = now();
    const beforeFeed = await readFeedState();
    if (!healthyFeed(beforeFeed)) return held();
    const beforeActivity = await readActivity();
    if (beforeActivity?.state !== 'quiet_observed') return held();
    await wait(minQuietMs);
    const afterActivity = await readActivity();
    const afterFeed = await readFeedState();
    const afterObservedAtMs = now();
    if (afterActivity?.state !== 'quiet_observed' ||
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
      episodeIds: [...episodeIds], beforeObservedAtMs, afterObservedAtMs };
  } catch { return held(); }
}
