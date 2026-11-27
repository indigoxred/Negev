import { createTimerLoop } from '../runtime/timer-loop.mjs';

// This clock only invokes the durable, bounded Airing page worker. It cannot
// dispatch a download. The caller must opt in and stop it before closing DBs.
export function createAiringScheduler({ runPage,
  initialDelayMs = 60_000, pageDelayMs = 10_000,
  cycleDelayMs = 3_600_000, failureDelayMs = 300_000,
  onError = (error) => process.stderr.write(
    `Negev Airing poll failed: ${error?.stack ?? error}\n`),
  setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
  if (typeof runPage !== 'function' || typeof onError !== 'function' ||
      typeof setTimeoutImpl !== 'function' || typeof clearTimeoutImpl !== 'function' ||
      [initialDelayMs, pageDelayMs, cycleDelayMs, failureDelayMs].some((value) =>
        !Number.isSafeInteger(value) || value < 1 || value > 86_400_000)) {
    throw new TypeError('Invalid Airing scheduler');
  }
  let lastResult = null;
  const loop = createTimerLoop({ failureDelayMs,
    setTimer: setTimeoutImpl, clearTimer: clearTimeoutImpl,
    run: async () => {
      try { lastResult = await runPage(); }
      catch (error) {
        lastResult = { state: 'held', reason: 'poll_failed' };
        try { onError(error); } catch { /* Reporting must not stop the loop. */ }
      }
      return lastResult?.state === 'page'
        ? lastResult.afterId === 0 && lastResult.continueSoon !== true ? cycleDelayMs : pageDelayMs
        : failureDelayMs;
    } });
  return {
    start() {
      if (!loop.start(initialDelayMs)) {
        throw new Error('Airing scheduler already started or stopped');
      }
    },
    stop: () => loop.close(),
    close: () => loop.close(),
    getLastResult() { return lastResult; },
  };
}
