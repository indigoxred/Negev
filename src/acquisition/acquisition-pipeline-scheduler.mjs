const stages = ['tickPublish', 'tickCompletions', 'tickStarts', 'tickRequests'];

// One paced clock for the four durable acquisition stages. Reconciliation
// finishes before the first tick, and a later stage cannot overlap an active
// media read. This clock has no provider credentials or startup wiring.
export function createPipelineScheduler({ pipeline,
  initialDelayMs = 60_000, stepDelayMs = 60_000,
  failureDelayMs = 5 * 60_000,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (typeof pipeline?.initialize !== 'function' ||
      typeof pipeline.close !== 'function' ||
      stages.some((name) => typeof pipeline[name] !== 'function') ||
      typeof setTimer !== 'function' || typeof clearTimer !== 'function' ||
      [initialDelayMs, stepDelayMs, failureDelayMs].some((value) =>
        !Number.isSafeInteger(value) || value < 1 || value > 86_400_000)) {
    throw new TypeError('Invalid pipeline scheduler');
  }
  let timer;
  let running;
  let initialization;
  let stopping;
  let started = false;
  let closed = false;
  let stageIndex = 0;
  let lastResult = null;
  const schedule = (delay) => {
    if (closed) return;
    timer = setTimer(() => {
      timer = undefined;
      running = tick().finally(() => { running = undefined; });
      return running;
    }, delay);
  };
  const tick = async () => {
    const stage = stages[stageIndex];
    stageIndex = (stageIndex + 1) % stages.length;
    try { lastResult = await pipeline[stage](); }
    catch { lastResult = { state: 'held', reason: 'worker_unavailable' }; }
    schedule(lastResult?.state === 'held' ? failureDelayMs : stepDelayMs);
  };
  return {
    start() {
      if (started || closed) throw new Error('Pipeline scheduler already started or stopped');
      started = true;
      initialization = (async () => {
        const result = await pipeline.initialize();
        if (result?.state === 'reconciled') schedule(initialDelayMs);
        return result;
      })();
      return initialization;
    },
    stop() {
      if (!stopping) {
        closed = true;
        if (timer !== undefined) clearTimer(timer);
        timer = undefined;
        stopping = (async () => {
          if (initialization) await Promise.allSettled([initialization]);
          if (running) await Promise.allSettled([running]);
          await pipeline.close();
        })();
      }
      return stopping;
    },
    getLastResult() { return lastResult; },
  };
}
