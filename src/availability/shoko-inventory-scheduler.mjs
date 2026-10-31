// Deliberately slow, opt-in reconciliation. It never reads more than one
// bounded Shoko file page per timer and does not infer deletion from a pass.
export function createShokoInventoryScheduler({ tick,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (typeof tick !== 'function' || typeof setTimer !== 'function' ||
      typeof clearTimer !== 'function') {
    throw new TypeError('Invalid Shoko inventory scheduler');
  }
  const pageDelay = 60_000;
  const passDelay = 24 * 60 * 60_000;
  const failureDelay = 5 * 60_000;
  let timer;
  let scheduledDelay;
  let running;
  let requestedDuringPage = false;
  let started = false;
  let stopping = false;
  let lastState = 'not_started';
  const schedule = (delay) => {
    if (stopping) return;
    scheduledDelay = delay;
    timer = setTimer(() => {
      timer = undefined;
      scheduledDelay = undefined;
      running = run().finally(() => { running = undefined; });
      return running;
    }, delay);
  };
  const run = async () => {
    let delay = failureDelay;
    try {
      const result = await tick();
      if (result?.state === 'recorded') {
        delay = result.nextPage === 1 ? passDelay : pageDelay;
        lastState = result.nextPage === 1 ? 'pass_complete' : 'page_complete';
      } else lastState = 'retry_wait';
    } catch { lastState = 'retry_wait'; }
    if (requestedDuringPage) {
      delay = Math.min(delay, pageDelay);
      requestedDuringPage = false;
    }
    if (!stopping) schedule(delay);
  };
  return {
    start() {
      if (stopping || started) return;
      started = true;
      lastState = 'waiting';
      schedule(pageDelay);
    },
    getState() { return { state: lastState, active: Boolean(running),
      scheduled: timer !== undefined }; },
    requestSoon() {
      if (!started || stopping) return;
      if (running) { requestedDuringPage = true; return; }
      if (timer !== undefined && scheduledDelay > pageDelay) {
        clearTimer(timer);
        timer = undefined;
        schedule(pageDelay);
      }
    },
    async close() {
      stopping = true;
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
      scheduledDelay = undefined;
      if (running) await running;
      lastState = 'stopped';
    },
  };
}
