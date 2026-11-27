import { createTimerLoop } from '../runtime/timer-loop.mjs';

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
  let inFlight;
  let closed = false;
  // Also callable directly; a manual run and a timer run never overlap.
  const runOnce = async () => {
    if (closed) return held('file_backfill_closed');
    if (inFlight) return held('file_backfill_busy');
    try { inFlight = Promise.resolve(tick()); }
    catch { return held('file_backfill_unavailable'); }
    try { return await inFlight; }
    catch { return held('file_backfill_unavailable'); }
    finally { inFlight = null; }
  };
  const loop = createTimerLoop({ failureDelayMs, setTimer, clearTimer,
    run: async () => {
      const result = await runOnce();
      return ['checked', 'partial'].includes(result?.state) ||
        (result?.state === 'held' && result.reason === 'metadata_busy')
        ? intervalMs : failureDelayMs;
    } });
  const close = async () => {
    closed = true;
    await loop.close();
    if (inFlight) await Promise.allSettled([inFlight]);
  };
  return {
    runOnce,
    start() { if (!closed) loop.start(intervalMs); },
    close,
    stop: close,
  };
}
