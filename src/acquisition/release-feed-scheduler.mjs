import { createTimerLoop } from '../runtime/timer-loop.mjs';

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
  let lastResult = null;
  const feeds = new Map(indexerIds.map(id => [id,
    { failures:0, lastAttemptMs:null, nextPollMs:null, blockedUntilMs:0 }]));
  const recheckMs = 3_600_000;
  const due = (state,cadence,clock) => Math.max(state.blockedUntilMs,
    state.lastAttemptMs === null ? clock :
      Math.min(state.nextPollMs ?? clock,state.lastAttemptMs + cadence));
  // Returns the next delay; returns nothing when stopped mid-pass.
  const tick = async () => {
    let pageWakes=0;
    try { pageWakes=feedLedger.drainPendingWatches?.().wokenRequests ?? 0; }
    catch { lastResult={state:'unavailable'};return 300_000; }
    let cadence;
    try { cadence = feedLedger.getPollIntervalMs({ nowMs:now() }); }
    catch { lastResult={state:'unavailable'};return 300_000; }
    if (cadence === null) {
      lastResult={state:'idle'};return feedLedger.hasPendingWatches?.() ? 1000 : 60_000;
    }
    if (!Number.isSafeInteger(cadence) || cadence < 1 || cadence > 86_400_000) {
      lastResult={state:'unavailable'};return 300_000;
    }
    let wokenRequests = pageWakes, attempted = false;
    for (const indexerId of indexerIds) {
      if (loop.stopped) return undefined;
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
    return feedLedger.hasPendingWatches?.() ? 1000 : Math.min(recheckMs,Math.max(1,nextDueMs-now()));
  };
  const loop = createTimerLoop({ run: tick, failureDelayMs: 300_000, setTimer, clearTimer });
  return {
    start() {
      if (!loop.start(60_000)) throw new Error('Release feed scheduler already started');
    },
    stop: () => loop.close(),
    close: () => loop.close(),
    getLastResult() { return lastResult; },
  };
}
