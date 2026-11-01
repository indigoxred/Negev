const held = (reason) => ({ state: 'held', reason });

// Source-only pacing for one file-level tick. The runtime must opt in after
// the public Plex and Shoko inventory load gates pass.
export function createFileBackfillScheduler({ tick,
  intervalMs = 60_000, failureDelayMs = 5 * 60_000,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (typeof tick !== 'function' || typeof setTimer !== 'function' ||
      typeof clearTimer !== 'function' ||
      !Number.isSafeInteger(intervalMs) || intervalMs < 10_000 ||
      intervalMs > 5 * 60_000 ||
      !Number.isSafeInteger(failureDelayMs) ||
      failureDelayMs < intervalMs || failureDelayMs > 30 * 60_000) {
    throw new TypeError('Invalid file backfill scheduler');
  }
  let timer;
  let inFlight;
  let started = false;
  let closed = false;
  const runOnce = async () => {
    if (closed) return held('file_backfill_closed');
    if (inFlight) return held('file_backfill_busy');
    try { inFlight = Promise.resolve(tick()); }
    catch { return held('file_backfill_unavailable'); }
    try { return await inFlight; }
    catch { return held('file_backfill_unavailable'); }
    finally { inFlight = null; }
  };
  const schedule = (delay) => {
    if (closed || !started) return;
    timer = setTimer(async () => {
      timer = undefined;
      const result = await runOnce();
      const nextDelay = ['checked', 'partial'].includes(result?.state)
        ? intervalMs : failureDelayMs;
      schedule(nextDelay);
    }, delay);
  };
  return {
    runOnce,
    start() {
      if (closed || started) return;
      started = true;
      schedule(intervalMs);
    },
    async close() {
      closed = true;
      started = false;
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
      if (inFlight) await Promise.allSettled([inFlight]);
    },
  };
}
