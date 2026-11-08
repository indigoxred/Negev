// Keep a pending metadata refresh well below the signed-in title-read budget.
export function detailRefreshDelay(attempt) {
  if (!Number.isSafeInteger(attempt) || attempt < 0) throw new TypeError('Invalid refresh attempt');
  return [15_000, 20_000, 30_000][Math.min(attempt, 2)];
}

// A deferred refresh has not been submitted to Shoko. Polling the detail GET
// alone can never start it, so retry dispatch after the global admission gap.
export function detailHydrationFollowup(result, attempt) {
  if (!Number.isSafeInteger(attempt) || attempt < 0) {
    throw new TypeError('Invalid refresh attempt');
  }
  if (result?.state === 'detail_ready') return { state: 'ready' };
  if (result?.state !== 'pending' || attempt >= 5) return { state: 'stop' };
  if (['global_cooldown', 'active_refresh'].includes(result.reason)) {
    return { state: 'retry', delayMs: 60_000 };
  }
  if (['refresh_queued', 'title_cooldown'].includes(result.reason)) {
    return { state: 'poll', delayMs: detailRefreshDelay(attempt) };
  }
  return { state: 'stop' };
}
