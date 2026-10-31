// This clock only invokes the durable, bounded Airing page worker. It cannot
// dispatch a download. The caller must opt in and stop it before closing DBs.
export function createAiringScheduler({ runPage,
  initialDelayMs = 60_000, pageDelayMs = 10_000,
  cycleDelayMs = 3_600_000, failureDelayMs = 300_000,
  setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
  if (typeof runPage !== 'function' ||
      typeof setTimeoutImpl !== 'function' || typeof clearTimeoutImpl !== 'function' ||
      [initialDelayMs, pageDelayMs, cycleDelayMs, failureDelayMs].some((value) =>
        !Number.isSafeInteger(value) || value < 1 || value > 86_400_000)) {
    throw new TypeError('Invalid Airing scheduler');
  }
  let timer = null;
  let running = null;
  let started = false;
  let stopped = false;
  let lastResult = null;
  const schedule = (delay) => {
    if (stopped) return;
    timer = setTimeoutImpl(() => {
      timer = null;
      running = tick();
      return running;
    }, delay);
  };
  const tick = async () => {
    try {
      try { lastResult = await runPage(); }
      catch { lastResult = { state: 'held', reason: 'poll_failed' }; }
      const delay = lastResult?.state === 'page'
        ? lastResult.afterId === 0 ? cycleDelayMs : pageDelayMs
        : failureDelayMs;
      schedule(delay);
    } finally { running = null; }
  };
  return {
    start() {
      if (started || stopped) throw new Error('Airing scheduler already started or stopped');
      started = true;
      schedule(initialDelayMs);
    },
    async stop() {
      stopped = true;
      if (timer !== null) clearTimeoutImpl(timer);
      timer = null;
      if (running) await running;
    },
    getLastResult() { return lastResult; },
  };
}
