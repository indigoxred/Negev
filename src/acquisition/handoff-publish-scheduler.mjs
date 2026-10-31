// Explicit opt-in clock for one durable publish check per tick. There is no
// production startup wiring; the caller must reconcile unresolved claims first.
export function createHandoffPublishScheduler({ runOnce,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (typeof runOnce !== 'function' || typeof setTimer !== 'function' ||
      typeof clearTimer !== 'function') {
    throw new TypeError('Invalid handoff publish scheduler');
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
    } catch {
      lastResult = { state: 'held', reason: 'worker_unavailable' };
    }
    schedule(delay);
  };
  return {
    start() {
      if (started || stopping) throw new Error('Handoff publish scheduler already started or stopped');
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
