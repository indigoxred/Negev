const stages = ['tickPublish', 'tickCompletions', 'tickStarts', 'tickRequests'];

// One paced clock for the four durable acquisition stages. Reconciliation
// finishes before the first tick, and a later stage cannot overlap an active
// media read. This clock has no provider credentials or startup wiring.
export function createPipelineScheduler({ pipeline,
  initialDelayMs = 60_000, stepDelayMs = 60_000,
  failureDelayMs = 5 * 60_000,
  now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (typeof pipeline?.initialize !== 'function' ||
      typeof pipeline.close !== 'function' ||
      stages.some((name) => typeof pipeline[name] !== 'function') ||
      typeof now !== 'function' || typeof setTimer !== 'function' ||
      typeof clearTimer !== 'function' ||
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
  let stopped = false;
  let recoveryState = 'not_started';
  let stageIndex = 0;
  let lastResult = null;
  let activeStage = null;
  let lastStage = null;
  let lastFinishedMs = null;
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
    activeStage = stage.slice(4).toLowerCase();
    let workerFailed = false;
    try { lastResult = await pipeline[stage](); }
    catch { workerFailed = true;
      lastResult = { state: 'held', reason: 'worker_unavailable' }; }
    lastStage = activeStage;
    activeStage = null;
    const finished = now();
    lastFinishedMs = Number.isSafeInteger(finished) && finished >= 0
      ? finished : null;
    // A durable worker may hold one target while later targets remain ready.
    // Reserve the longer backoff for an actual worker failure.
    schedule(workerFailed ? failureDelayMs : stepDelayMs);
  };
  const scheduleRecovery = () => {
    if (closed) return;
    timer = setTimer(() => {
      timer = undefined;
      return reconcile().catch(() => {});
    }, failureDelayMs);
  };
  const reconcile = () => {
    recoveryState = 'reconciling';
    initialization = (async () => {
      try {
        const result = await pipeline.initialize();
        recoveryState = result?.state === 'reconciled'
          ? 'waiting' : 'reconciliation_held';
        if (result?.state === 'reconciled') schedule(initialDelayMs);
        else scheduleRecovery();
        return result;
      } catch (error) {
        recoveryState = 'reconciliation_failed';
        scheduleRecovery();
        throw error;
      }
    })();
    return initialization;
  };
  return {
    start() {
      if (started || closed) throw new Error('Pipeline scheduler already started or stopped');
      started = true;
      return reconcile();
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
          stopped = true;
        })();
      }
      return stopping;
    },
    getLastResult() { return lastResult; },
    getStatus() {
      return { state: stopped ? 'stopped' : closed ? 'stopping' :
        activeStage ? 'running' : recoveryState,
      activeStage, lastStage,
      lastResult: typeof lastResult?.state === 'string'
        ? lastResult.state : null,
      lastFinishedMs };
    },
  };
}
