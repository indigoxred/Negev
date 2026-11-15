// Shared clock for the installed Prowlarr indexers. A feed result can only
// wake an existing guarded request through the durable feed ledger.
export function createReleaseFeedScheduler({ indexerIds, feedLedger,
  readFeed, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (!Array.isArray(indexerIds) || indexerIds.length < 1 ||
      indexerIds.length > 20 ||
      indexerIds.some((id) => !Number.isSafeInteger(id) || id < 1) ||
      new Set(indexerIds).size !== indexerIds.length ||
      typeof feedLedger?.getPollIntervalMs !== 'function' ||
      typeof feedLedger?.accept !== 'function' ||
      typeof readFeed !== 'function' || typeof now !== 'function' ||
      typeof setTimer !== 'function' || typeof clearTimer !== 'function') {
    throw new TypeError('Invalid release feed scheduler');
  }
  let started = false;
  let stopped = false;
  let timer;
  let running;
  let failures = 0;
  let lastResult = null;
  let lastAttemptMs = null;
  let nextPollMs = null;
  let blockedUntilMs = 0;
  const recheckMs = 3_600_000;
  const schedule = (delay) => {
    if (stopped) return;
    timer = setTimer(() => {
      timer = undefined;
      running = tick().finally(() => { running = undefined; });
      return running;
    }, delay);
  };
  const tick = async () => {
    let cadence;
    try { cadence = feedLedger.getPollIntervalMs({ nowMs: now() }); }
    catch { lastResult = { state: 'unavailable' }; schedule(5 * 60_000); return; }
    if (cadence === null) {
      lastResult = { state: 'idle' };
      nextPollMs = null;
      schedule(60_000);
      return;
    }
    const clock = now();
    const cadenceDueMs = lastAttemptMs === null ? clock :
      Math.min(nextPollMs ?? clock, lastAttemptMs + cadence);
    const dueMs = Math.max(cadenceDueMs, blockedUntilMs);
    if (clock < dueMs) {
      schedule(Math.min(recheckMs, dueMs - clock));
      return;
    }
    lastAttemptMs = clock;
    let failed = false;
    let retryAfterMs = 0;
    let wokenRequests = 0;
    for (const indexerId of indexerIds) {
      let result;
      try { result = await readFeed(indexerId); }
      catch { result = { state: 'unavailable' }; }
      if (result?.state !== 'feed' || !Array.isArray(result.items)) {
        failed = true;
        retryAfterMs = Math.max(retryAfterMs,
          Number.isSafeInteger(result?.retryAfterMs) ? result.retryAfterMs : 0);
        continue;
      }
      try {
        const recorded = feedLedger.accept({ indexerId,
          items: result.items, nowMs: now() });
        wokenRequests += recorded.wokenRequests;
      } catch { failed = true; }
    }
    failures = failed ? Math.min(failures + 1, 8) : 0;
    lastResult = { state: failed ? 'unavailable' : 'checked', wokenRequests };
    const finishedMs = now();
    blockedUntilMs = failed ? finishedMs + Math.min(86_400_000,
      Math.max(retryAfterMs, 5 * 60_000 * 2 ** (failures - 1))) : 0;
    nextPollMs = finishedMs + cadence;
    schedule(Math.min(recheckMs, Math.max(1, nextPollMs - now())));
  };
  return {
    start() {
      if (started || stopped) throw new Error('Release feed scheduler already started');
      started = true;
      schedule(60_000);
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
