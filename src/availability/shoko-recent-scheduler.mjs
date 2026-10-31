// Source-only pacing for the durable recent-file worker. The server does not
// instantiate this yet: Shoko's installed sort contract and sustained cost
// must be checked before any NAS scheduling is enabled.
export function createShokoRecentScheduler({ scan, drainOne,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (typeof scan !== 'function' || typeof drainOne !== 'function' ||
      typeof setTimer !== 'function' || typeof clearTimer !== 'function') {
    throw new TypeError('Invalid Shoko recent scheduler');
  }
  const scanDelay = 30 * 60_000;
  const gapDelay = 60_000;
  const drainDelay = 10_000;
  const failureDelay = 5 * 60_000;
  let timer;
  let scheduledKind;
  let scheduledDelay;
  let running;
  let started = false;
  let stopping = false;
  let requested = false;
  let drainsSinceScan = 0;
  let scanFailed = false;
  let lastState = 'not_started';

  const schedule = (kind, delay) => {
    if (stopping) return;
    scheduledKind = kind;
    scheduledDelay = delay;
    timer = setTimer(() => {
      timer = undefined;
      scheduledKind = undefined;
      scheduledDelay = undefined;
      running = run(kind).finally(() => { running = undefined; });
      return running;
    }, delay);
  };
  const run = async (kind) => {
    let result;
    try { result = await (kind === 'scan' ? scan() : drainOne()); }
    catch { result = { state: 'held' }; }
    if (stopping) return;
    lastState = result?.state ?? 'held';
    if (kind === 'scan') {
      drainsSinceScan = 0;
      scanFailed = result?.state !== 'caught_up';
      schedule('drain', drainDelay);
      return;
    }
    drainsSinceScan++;
    if (requested) {
      requested = false;
      schedule('scan', gapDelay);
    } else if (['acknowledged', 'retry_scheduled'].includes(result?.state) &&
        drainsSinceScan < 30) {
      schedule('drain', drainDelay);
    } else {
      schedule('scan', result?.state === 'idle' ?
        scanFailed ? failureDelay : scanDelay : gapDelay);
    }
  };
  return {
    start() {
      if (started || stopping) return;
      started = true;
      lastState = 'waiting';
      schedule('scan', scanDelay);
    },
    requestSoon() {
      if (!started || stopping) return;
      if (running) { requested = true; return; }
      if (timer === undefined ||
          scheduledKind === 'scan' && scheduledDelay <= gapDelay) return;
      clearTimer(timer);
      timer = undefined;
      schedule('scan', gapDelay);
    },
    getState() { return { state: lastState, active: Boolean(running),
      scheduled: timer !== undefined }; },
    async close() {
      stopping = true;
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
      if (running) await running;
      lastState = 'stopped';
    },
  };
}
