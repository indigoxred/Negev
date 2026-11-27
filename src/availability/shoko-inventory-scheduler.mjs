import { createTimerLoop } from '../runtime/timer-loop.mjs';

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
  let requestedDuringPage = false;
  let lastState = 'not_started';
  const run = async () => {
    let delay = failureDelay;
    try {
      const result = await tick();
      if (result?.state === 'recorded') {
        delay = result.nextPage === 1 ? passDelay : pageDelay;
        lastState = result.nextPage === 1 ? 'pass_complete' : 'page_complete';
      } else if (result?.state === 'delivered' ||
          result?.reason === 'change_delivery_backlog') {
        delay = pageDelay;
        lastState = 'change_replay';
      } else if (result?.reason === 'omission_budget_exceeded') {
        // The safety cap needs review, not an intensive automatic rescan.
        delay = passDelay;
        lastState = 'review_needed';
      } else if (result?.reason === 'full_reconciliation_pending') {
        // A full Shoko pass can be expensive. Do not add extra full passes
        // until the installed endpoint and NAS load have been measured.
        delay = passDelay;
        lastState = 'catchup_wait';
      } else lastState = 'retry_wait';
    } catch { lastState = 'retry_wait'; }
    if (requestedDuringPage) {
      delay = Math.min(delay, pageDelay);
      requestedDuringPage = false;
    }
    return delay;
  };
  const loop = createTimerLoop({ run, failureDelayMs: failureDelay,
    setTimer, clearTimer });
  const close = async () => {
    await loop.close();
    lastState = 'stopped';
  };
  return {
    start() {
      if (loop.start(pageDelay)) lastState = 'waiting';
    },
    getState() { return { state: lastState, active: loop.running,
      scheduled: loop.scheduled }; },
    requestSoon() {
      if (!loop.started || loop.stopped) return;
      if (loop.running) { requestedDuringPage = true; return; }
      if (loop.scheduled && loop.scheduledDelay > pageDelay) loop.reschedule(pageDelay);
    },
    close,
    stop: close,
  };
}
