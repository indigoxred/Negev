const TITLE_RETRY_MS = 24 * 60 * 60 * 1_000;
const GLOBAL_GAP_MS = 60 * 1_000;
const DAILY_LIMIT = 30;
const defer = (reason, retryAtMs) => retryAtMs === undefined
  ? { state: 'defer', reason }
  : { state: 'defer', reason, retryAtMs };

function validTimestamp(value) {
  return value === null || (Number.isSafeInteger(value) && value >= 0);
}

// Pure policy. The future caller must persist an atomic cross-worker claim
// before calling Shoko; this function alone cannot prevent concurrent writes.
export function planHydration({
  anidbId, titleKnown, detailState, nowMs,
  activeRefreshes = 0, attempts24h = 0,
  lastTitleAttemptMs = null, lastGlobalAttemptMs = null,
}) {
  if (!Number.isSafeInteger(anidbId) || anidbId <= 0 ||
      typeof titleKnown !== 'boolean' ||
      !['details', 'detail_pending', 'unavailable'].includes(detailState) ||
      !Number.isSafeInteger(nowMs) || nowMs < 0 ||
      !Number.isSafeInteger(activeRefreshes) || activeRefreshes < 0 ||
      !Number.isSafeInteger(attempts24h) || attempts24h < 0 ||
      !validTimestamp(lastTitleAttemptMs) || !validTimestamp(lastGlobalAttemptMs)) {
    throw new TypeError('Invalid AniDB hydration evidence');
  }
  if (!titleKnown) return defer('unknown_title');
  if (detailState === 'details') return { state: 'no_refresh', reason: 'details_present' };
  if (detailState === 'unavailable') return defer('detail_unavailable');
  if (lastTitleAttemptMs > nowMs || lastGlobalAttemptMs > nowMs) return defer('clock_skew');
  if (activeRefreshes > 0) return defer('active_refresh');
  if (attempts24h >= DAILY_LIMIT) return defer('daily_budget');
  if (lastTitleAttemptMs !== null && nowMs - lastTitleAttemptMs < TITLE_RETRY_MS) {
    return defer('title_cooldown', lastTitleAttemptMs + TITLE_RETRY_MS);
  }
  if (lastGlobalAttemptMs !== null && nowMs - lastGlobalAttemptMs < GLOBAL_GAP_MS) {
    return defer('global_cooldown', lastGlobalAttemptMs + GLOBAL_GAP_MS);
  }
  return { state: 'admit' };
}
