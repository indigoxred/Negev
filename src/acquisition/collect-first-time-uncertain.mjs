import { collectUnimportedTargets } from './collect-unimported-targets.mjs';

const validId = (value) => Number.isSafeInteger(value) && value > 0;
const held = (reason) => ({ state: 'held', reason });

// Build the explicitly uncertain first-attempt snapshot. The same exact
// Shoko targets and public Plex section health are checked on both sides of a
// connected, fingerprinted Import quiet window. This cannot claim a public
// title absent; the owner explicitly accepts one uncertain first attempt.
export async function collectFirstTimeUncertain({ anidbId, episodeIds,
  kind, publicLibraryIds, readEpisode, probePublic,
  observeImport, readFeedState, now = Date.now } = {}) {
  if (!validId(anidbId) || !Array.isArray(episodeIds) ||
      episodeIds.length < 1 || episodeIds.length > 20 ||
      episodeIds.some((id) => !validId(id)) ||
      new Set(episodeIds).size !== episodeIds.length ||
      !['series', 'movie'].includes(kind) ||
      !Array.isArray(publicLibraryIds) ||
      publicLibraryIds.length < 1 || publicLibraryIds.length > 4 ||
      publicLibraryIds.some((id) => !validId(id)) ||
      new Set(publicLibraryIds).size !== publicLibraryIds.length ||
      [readEpisode, probePublic, observeImport, readFeedState, now]
        .some((value) => typeof value !== 'function')) {
    throw new TypeError('Invalid uncertain first-time observation');
  }
  const scope = { anidbId, episodeIds: [...episodeIds] };
  const inspectShoko = () => collectUnimportedTargets({ ...scope, readEpisode });
  const inspectPublic = async () => {
    let result;
    try { result = await probePublic({ kind }); }
    catch { return held('public_probe_unverified'); }
    if (result?.state !== 'healthy_unconfirmed' ||
        result.probeCoverage !== 'health_only' ||
        result.complete !== false ||
        !Array.isArray(result.libraryIds) ||
        result.libraryIds.length !== publicLibraryIds.length ||
        new Set(result.libraryIds).size !== publicLibraryIds.length ||
        publicLibraryIds.some((id) => !result.libraryIds.includes(id)) ||
        !Array.isArray(result.parts) || result.parts.length !== 0) {
      return held('public_probe_unverified');
    }
    return { state: 'healthy_unconfirmed',
      libraryIds: [...publicLibraryIds], parts: [], complete: false,
      probeCoverage: 'health_only' };
  };
  const firstShoko = await inspectShoko();
  if (firstShoko.state !== 'unimported_targets') return firstShoko;
  const firstPublic = await inspectPublic();
  if (firstPublic.state !== 'healthy_unconfirmed') return firstPublic;
  let fence;
  try { fence = await observeImport(scope); }
  catch { return held('import_quiet_window_unverified'); }
  if (fence?.state !== 'quiet_window_observed' ||
      fence.anidbId !== anidbId ||
      !Array.isArray(fence.episodeIds) ||
      fence.episodeIds.length !== episodeIds.length ||
      new Set(fence.episodeIds).size !== episodeIds.length ||
      episodeIds.some((id) => !fence.episodeIds.includes(id)) ||
      !Number.isSafeInteger(fence.beforeObservedAtMs) ||
      !Number.isSafeInteger(fence.afterObservedAtMs) ||
      !Number.isSafeInteger(fence.feedGeneration) ||
      fence.feedGeneration < 0 ||
      fence.beforeObservedAtMs < 0 ||
      fence.afterObservedAtMs - fence.beforeObservedAtMs < 120_000 ||
      fence.afterObservedAtMs - fence.beforeObservedAtMs > 330_000) {
    return held('import_quiet_window_unverified');
  }
  const secondShoko = await inspectShoko();
  if (secondShoko.state !== 'unimported_targets') return secondShoko;
  const secondPublic = await inspectPublic();
  if (secondPublic.state !== 'healthy_unconfirmed') return secondPublic;
  let finalFeed;
  try { finalFeed = await readFeedState(); }
  catch { return held('import_quiet_window_unverified'); }
  if (finalFeed?.state !== 'connected' ||
      finalFeed.generation !== fence.feedGeneration ||
      finalFeed.pendingPaths !== 0 || finalFeed.pendingEvents !== 0 ||
      finalFeed.inFlight !== false ||
      finalFeed.reconciliationNeeded !== false) {
    return held('import_quiet_window_unverified');
  }
  const observedAtMs = now();
  if (!Number.isSafeInteger(observedAtMs) ||
      fence.afterObservedAtMs > observedAtMs ||
      observedAtMs - fence.afterObservedAtMs > 30_000) {
    return held('import_quiet_window_unverified');
  }
  return { ...scope, observedAtMs, shoko: secondShoko,
    plex: secondPublic,
    importFence: { state: 'quiet_window_observed', ...scope,
      beforeObservedAtMs: fence.beforeObservedAtMs,
      afterObservedAtMs: fence.afterObservedAtMs,
      feedGeneration: fence.feedGeneration } };
}
