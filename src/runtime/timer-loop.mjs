// One background loop: run a step, wait the delay the step returns, repeat.
// Steps never overlap, close() waits for the step in flight, and a step that
// throws is reported and retried later instead of silently ending the loop.
//
// `run` returns the next delay in milliseconds, or anything else to stop
// scheduling (for example when the owner is shutting down mid-step).
export function createTimerLoop({ run, failureDelayMs = 5 * 60_000,
  onError = () => {}, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (typeof run !== 'function' || typeof onError !== 'function' ||
      typeof setTimer !== 'function' || typeof clearTimer !== 'function' ||
      !Number.isSafeInteger(failureDelayMs) || failureDelayMs < 1) {
    throw new TypeError('Invalid timer loop');
  }
  let timer;
  let scheduledDelay;
  let running;
  let started = false;
  let stopped = false;
  const step = async () => {
    let next;
    try { next = await run(); }
    catch (error) {
      try { onError(error); } catch { /* Reporting must not stop the loop. */ }
      next = failureDelayMs;
    }
    if (typeof next === 'number' && Number.isFinite(next) && next >= 0) schedule(next);
  };
  const schedule = (delay) => {
    if (stopped) return;
    scheduledDelay = delay;
    timer = setTimer(() => {
      timer = undefined;
      scheduledDelay = undefined;
      running = step().finally(() => { running = undefined; });
      return running;
    }, delay);
  };
  return {
    // Returns false when the loop was already started or has been closed.
    start(initialDelayMs) {
      if (started || stopped) return false;
      started = true;
      schedule(initialDelayMs);
      return true;
    },
    // Replace the pending wait (no effect while a step runs or after close).
    reschedule(delay) {
      if (stopped || timer === undefined) return false;
      clearTimer(timer);
      timer = undefined;
      schedule(delay);
      return true;
    },
    get started() { return started; },
    get stopped() { return stopped; },
    get running() { return running !== undefined; },
    get scheduled() { return timer !== undefined; },
    get scheduledDelay() { return scheduledDelay; },
    async close() {
      stopped = true;
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
      scheduledDelay = undefined;
      if (running) await running;
    },
  };
}
