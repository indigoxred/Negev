// Explicit opt-in runner. One target per tick, with no overlapping reads.
// An idle queue backs off; failures retry after five minutes.
export function createDirectAvailabilityScheduler({ runOnce,
  idleDelayMs = 5 * 60_000,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (typeof runOnce !== 'function' || typeof setTimer !== 'function' ||
      typeof clearTimer !== 'function' ||
      !Number.isSafeInteger(idleDelayMs) || idleDelayMs < 60_000 ||
      idleDelayMs > 5 * 60_000) {
    throw new TypeError('Invalid direct availability scheduler');
  }
  let timer;
  let running;
  let started = false;
  let stopping = false;
  const schedule = (delay) => {
    if (stopping) return;
    timer = setTimer(() => {
      timer = undefined;
      running = tick().finally(() => { running = undefined; });
      return running;
    }, delay);
  };
  const tick = async () => {
    let delay = idleDelayMs;
    try {
      const result = await runOnce();
      if (['checked', 'page_loaded', 'target_checked'].includes(result?.state) ||
          result?.reason === 'stale_claim') {
        delay = 60_000;
      }
    } catch { /* Unknown is retried by the durable queue after its lease. */ }
    schedule(delay);
  };
  return {
    start() {
      if (started || stopping) return;
      started = true;
      schedule(60_000);
    },
    async close() {
      stopping = true;
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
      if (running) await running;
    },
  };
}
