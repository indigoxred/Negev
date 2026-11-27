import { createTimerLoop } from '../runtime/timer-loop.mjs';

// Explicit opt-in runner. One target per tick, with no overlapping reads.
// An idle queue backs off; failures retry after the idle delay.
export function createDirectAvailabilityScheduler({ runOnce,
  initialDelayMs = 60_000,
  idleDelayMs = 5 * 60_000,
  activeDelayMs = 60_000, name = runOnce?.name || 'background',
  onError = (error) => process.stderr.write(
    `Negev ${name} tick failed: ${error?.stack ?? error}\n`),
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (typeof runOnce !== 'function' || typeof setTimer !== 'function' ||
      typeof clearTimer !== 'function' || typeof onError !== 'function' ||
      !Number.isSafeInteger(initialDelayMs) || initialDelayMs < 1_000 ||
      initialDelayMs > 300_000 ||
      !Number.isSafeInteger(idleDelayMs) || idleDelayMs < 60_000 ||
      idleDelayMs > 5 * 60_000 ||
      !Number.isSafeInteger(activeDelayMs) || activeDelayMs < 10_000 ||
      activeDelayMs > 5 * 60_000) {
    throw new TypeError('Invalid direct availability scheduler');
  }
  // Unknown is retried by the durable queue after its lease; only report it.
  const loop = createTimerLoop({ failureDelayMs: idleDelayMs, onError,
    setTimer, clearTimer,
    run: async () => {
      const result = await runOnce();
      return ['checked', 'page_loaded', 'target_checked'].includes(result?.state) ||
        ['stale_claim', 'metadata_busy', 'card_changed', 'shoko_changed']
          .includes(result?.reason) ? activeDelayMs : idleDelayMs;
    } });
  return {
    start() { loop.start(initialDelayMs); },
    close: () => loop.close(),
    stop: () => loop.close(),
  };
}
