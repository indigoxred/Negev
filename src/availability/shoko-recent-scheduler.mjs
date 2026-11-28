import { createTimerLoop } from '../runtime/timer-loop.mjs';

// Bounded pacing for the durable recent-file worker. A file-ID scan uses at
// most five pages and ordinary idle scans normally read the newest page.
export function createShokoRecentScheduler({ scan, drainOne,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (typeof scan !== 'function' || typeof drainOne !== 'function' ||
      typeof setTimer !== 'function' || typeof clearTimer !== 'function') {
    throw new TypeError('Invalid Shoko recent scheduler');
  }
  const scanDelay = 5 * 60_000;
  const initialDelay = 60_000;
  const gapDelay = 60_000;
  const drainDelay = 10_000;
  const failureDelay = 5 * 60_000;
  let nextKind = 'scan';
  let requested = false;
  let drainsSinceScan = 0;
  let scanFailed = false;
  let lastState = 'not_started';

  // Runs one scan or drain and returns the wait before the next step.
  const run = async () => {
    const kind = nextKind;
    let result;
    try { result = await (kind === 'scan' ? scan() : drainOne()); }
    catch { result = { state: 'held' }; }
    if (loop.stopped) return undefined;
    if (kind === 'scan' || !scanFailed) lastState = result?.state ?? 'held';
    if (kind === 'scan') {
      drainsSinceScan = 0;
      scanFailed = result?.state !== 'caught_up';
      nextKind = 'drain';
      return drainDelay;
    }
    drainsSinceScan++;
    if (requested) {
      requested = false;
      nextKind = 'scan';
      return gapDelay;
    }
    if (['acknowledged', 'retry_scheduled', 'retired'].includes(result?.state) && drainsSinceScan < 30) {
      nextKind = 'drain';
      return drainDelay;
    }
    nextKind = 'scan';
    return result?.state === 'idle' ? scanFailed ? failureDelay : scanDelay : gapDelay;
  };
  const loop = createTimerLoop({ run, failureDelayMs: failureDelay, setTimer, clearTimer });
  const close = async () => {
    await loop.close();
    lastState = 'stopped';
  };
  return {
    start() {
      if (loop.started || loop.stopped) return;
      nextKind = 'scan';
      if (loop.start(initialDelay)) lastState = 'waiting';
    },
    requestSoon() {
      if (!loop.started || loop.stopped) return;
      if (loop.running) { requested = true; return; }
      if (!loop.scheduled || nextKind === 'scan' && loop.scheduledDelay <= gapDelay) return;
      // Preserve the first durable drain after every scan despite busy hints.
      if (nextKind === 'drain' && drainsSinceScan === 0) { requested = true; return; }
      nextKind = 'scan';
      loop.reschedule(gapDelay);
    },
    getState() { return { state: lastState, active: loop.running, scheduled: loop.scheduled }; },
    close,
    stop: close,
  };
}
