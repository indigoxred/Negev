// One clock, independent deadlines for installed Prowlarr indexers. A feed hit
// only wakes an existing guarded request through the durable feed ledger.
export function createReleaseFeedScheduler({ indexerIds, feedLedger,
  readFeed, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (!Array.isArray(indexerIds) || indexerIds.length < 1 ||
      indexerIds.length > 20 ||
      indexerIds.some(id => !Number.isSafeInteger(id) || id < 1) ||
      new Set(indexerIds).size !== indexerIds.length ||
      typeof feedLedger?.getPollIntervalMs !== 'function' ||
      typeof feedLedger?.accept !== 'function' ||
      [readFeed,now,setTimer,clearTimer].some(fn => typeof fn !== 'function')) {
    throw new TypeError('Invalid release feed scheduler');
  }
  let started = false, stopped = false, timer, running, lastResult = null;
  const feeds = new Map(indexerIds.map(id => [id,
    { failures:0, lastAttemptMs:null, nextPollMs:null, blockedUntilMs:0 }]));
  const recheckMs = 3_600_000;
  const schedule = delay => {
    if (stopped) return;
    timer = setTimer(() => {
      timer = undefined;
      running = tick().finally(() => { running = undefined; });
      return running;
    }, delay);
  };
  const due = (state,cadence,clock) => Math.max(state.blockedUntilMs,
    state.lastAttemptMs === null ? clock :
      Math.min(state.nextPollMs ?? clock,state.lastAttemptMs + cadence));
  const tick = async () => {
    let pageWakes=0;
    try { pageWakes=feedLedger.drainPendingWatches?.().wokenRequests ?? 0; }
    catch { lastResult={state:'unavailable'};schedule(300_000);return; }
    let cadence;
    try { cadence = feedLedger.getPollIntervalMs({ nowMs:now() }); }
    catch { lastResult={state:'unavailable'};schedule(300_000);return; }
    if (cadence === null) {
      lastResult={state:'idle'};schedule(feedLedger.hasPendingWatches?.() ? 1000 : 60_000);return;
    }
    if (!Number.isSafeInteger(cadence) || cadence < 1 || cadence > 86_400_000) {
      lastResult={state:'unavailable'};schedule(300_000);return;
    }
    let wokenRequests = pageWakes, attempted = false;
    for (const indexerId of indexerIds) {
      if (stopped) return;
      const state=feeds.get(indexerId);
      if (now() < due(state,cadence,now())) continue;
      attempted=true;
      state.lastAttemptMs=now();
      let result,failed=false;
      try { result=await readFeed(indexerId); }
      catch { result={state:'unavailable'}; }
      if (result?.state !== 'feed' || !Array.isArray(result.items)) failed=true;
      else {
        try {
          const recorded=feedLedger.accept({indexerId,items:result.items,nowMs:now()});
          if (!Number.isSafeInteger(recorded?.wokenRequests) || recorded.wokenRequests < 0) {
            throw new Error('Invalid feed acceptance');
          }
          wokenRequests+=recorded.wokenRequests;
        } catch { failed=true; }
      }
      state.failures=failed ? Math.min(state.failures+1,8) : 0;
      // An indexer's Retry-After is not evidence that unrelated indexers are
      // limited. If the provider refuses every feed, each honours its deadline.
      const retryAfterMs=Number.isSafeInteger(result?.retryAfterMs) && result.retryAfterMs>0
        ? Math.min(result.retryAfterMs,86_400_000) : 0;
      state.blockedUntilMs=failed ? now()+Math.min(86_400_000,
        Math.max(retryAfterMs,300_000*2**(state.failures-1))) : 0;
      state.nextPollMs=failed ? state.blockedUntilMs : now()+cadence;
    }
    if (attempted) lastResult={state:[...feeds.values()].some(f=>f.failures>0)
      ? 'unavailable' : 'checked',wokenRequests};
    const nextDueMs=Math.min(...[...feeds.values()].map(state=>due(state,cadence,now())));
    schedule(feedLedger.hasPendingWatches?.() ? 1000 : Math.min(recheckMs,Math.max(1,nextDueMs-now())));
  };
  return {
    start() {
      if (started || stopped) throw new Error('Release feed scheduler already started');
      started=true;schedule(60_000);
    },
    async stop() {
      stopped=true;
      if (timer !== undefined) clearTimer(timer);
      timer=undefined;
      if (running) await running;
    },
    getLastResult() { return lastResult; },
  };
}
