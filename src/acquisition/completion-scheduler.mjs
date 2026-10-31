// Explicit opt-in clock for the durable completed-attempt worker. It starts
// after one minute, invokes only one attempt per tick, and drains on shutdown.
// The worker owns the crash-safe claim and all byte verification.
export function createCompletionScheduler({ runOnce,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (typeof runOnce !== 'function' || typeof setTimer !== 'function' ||
      typeof clearTimer !== 'function') {
    throw new TypeError('Invalid completion scheduler');
  }
  let timer;
  let running;
  let started = false;
  let stopping = false;
  let lastResult = null;
  const schedule = (delay) => {
    if (stopping) return;
    timer = setTimer(() => {
      timer = undefined;
      running = tick().finally(() => { running = undefined; });
      return running;
    }, delay);
  };
  const tick = async () => {
    let delay = 5 * 60_000;
    try {
      lastResult = await runOnce();
      if (lastResult?.state === 'processed') delay = 60_000;
      else if (lastResult?.state === 'pass_complete') delay = 30 * 60_000;
    } catch {
      lastResult = { state: 'held', reason: 'worker_unavailable' };
    }
    schedule(delay);
  };
  return {
    start() {
      if (started || stopping) throw new Error('Completion scheduler already started or stopped');
      started = true;
      schedule(60_000);
    },
    async stop() {
      stopping = true;
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
      if (running) await running;
    },
    getLastResult() { return lastResult; },
  };
}
