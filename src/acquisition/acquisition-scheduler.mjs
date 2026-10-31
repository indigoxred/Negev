// Clock for the durable acquisition page worker. It does not select releases,
// prove absence, or submit torrents; those remain the worker's guarded duties.
// The caller must explicitly start it and drain it before closing ledgers.
export function createAcquisitionScheduler({ runPage,
  initialDelayMs = 60_000, pageDelayMs = 60_000,
  cycleDelayMs = 30 * 60_000, failureDelayMs = 5 * 60_000,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (typeof runPage !== 'function' || typeof setTimer !== 'function' ||
      typeof clearTimer !== 'function' ||
      [initialDelayMs, pageDelayMs, cycleDelayMs, failureDelayMs].some((value) =>
        !Number.isSafeInteger(value) || value < 1 || value > 86_400_000)) {
    throw new TypeError('Invalid acquisition scheduler');
  }
  let timer;
  let running;
  let started = false;
  let stopped = false;
  let lastResult = null;
  const schedule = (delay) => {
    if (stopped) return;
    timer = setTimer(() => {
      timer = undefined;
      running = tick();
      return running;
    }, delay);
  };
  const tick = async () => {
    try {
      try { lastResult = await runPage(); }
      catch { lastResult = { state: 'held', reason: 'worker_unavailable' }; }
      const delay = lastResult?.state === 'page' ? pageDelayMs :
        lastResult?.state === 'pass_complete' ? cycleDelayMs : failureDelayMs;
      schedule(delay);
    } finally { running = undefined; }
  };
  return {
    start() {
      if (started || stopped) throw new Error('Acquisition scheduler already started or stopped');
      started = true;
      schedule(initialDelayMs);
    },
    async stop() {
      stopped = true;
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
      if (running) await running;
    },
    getLastResult() { return lastResult; },
  };
}
