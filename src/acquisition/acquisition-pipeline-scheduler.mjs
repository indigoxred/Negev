const baseStages = ['tickCompletions', 'tickPublish', 'tickStarts', 'tickRequests'];
const hasReviewHolds = (result) => [result?.requests, result?.starts,
  result?.completions, result?.publishes]
  .some((queue) => Array.isArray(queue?.held) && queue.held.length > 0);

// One paced clock for the four durable acquisition stages. Each queue is
// reviewed before the first tick; unresolved claims stay excluded while
// independent work proceeds. A later stage cannot overlap an active media
// read. This clock has no provider credentials or startup wiring.
export function createPipelineScheduler({ pipeline,
  initialDelayMs = 15_000, stepDelayMs = 15_000,
  failureDelayMs = 5 * 60_000,
  now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (typeof pipeline?.initialize !== 'function' ||
      typeof pipeline.close !== 'function' ||
      baseStages.some((name) => typeof pipeline[name] !== 'function') ||
      typeof now !== 'function' || typeof setTimer !== 'function' ||
      typeof clearTimer !== 'function' ||
      [initialDelayMs, stepDelayMs, failureDelayMs].some((value) =>
        !Number.isSafeInteger(value) || value < 1 || value > 86_400_000)) {
    throw new TypeError('Invalid pipeline scheduler');
  }
  let timer;
  let scheduledDueMs;
  const stages = pipeline.tickRecovery
    ? ['tickCompletions', 'tickPublish', 'tickRecovery',
      'tickStarts', 'tickRequests'] : baseStages;
  let running;
  let requestRunning;
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
  let reviewHeld = false;
  const freshRequests = [];
  const metadataRetries = new Map();
  let priorityServed = false;
  const recordRequestResult = (result) => {
    if (!Array.isArray(result?.results)) return;
    for (const item of result.results) {
      if (!Number.isSafeInteger(item?.requestId) || item.requestId < 1) continue;
      if (item.reason === 'shoko_metadata_missing' &&
          Number.isSafeInteger(item.nextDueMs) &&
          item.nextDueMs >= 0 && metadataRetries.size < 32) {
        metadataRetries.set(item.requestId, item.nextDueMs);
      } else metadataRetries.delete(item.requestId);
      if (Number.isSafeInteger(item.continuationDueMs) &&
          item.continuationDueMs <= now() &&
          !freshRequests.includes(item.requestId) && freshRequests.length < 32) {
        freshRequests.push(item.requestId);
      }
    }
    if (!closed && timer !== undefined) {
      const metadataDue = metadataRetries.size > 0
        ? Math.min(...metadataRetries.values()) : null;
      const wantedDue = freshRequests.length > 0 && !priorityServed
        ? now() + 1_000 : metadataDue;
      if (wantedDue !== null && wantedDue < scheduledDueMs) {
        clearTimer(timer);
        schedule(Math.max(1_000, wantedDue - now()));
      }
    }
  };
  const schedule = (delay) => {
    if (closed) return;
    scheduledDueMs = now() + delay;
    timer = setTimer(() => {
      timer = undefined;
      scheduledDueMs = undefined;
      running = tick().finally(() => { running = undefined; });
      return running;
    }, delay);
  };
  const tick = async () => {
    const dueMetadataId = [...metadataRetries].find(([, due]) => due <= now())?.[0];
    const pendingId = freshRequests[0] ?? dueMetadataId;
    const prioritized = !requestRunning && pendingId !== undefined &&
      (!priorityServed || stages[stageIndex] === 'tickRequests');
    const stage = prioritized ? 'tickRequests' : stages[stageIndex];
    const priorityRequestId = prioritized ?
      freshRequests.length > 0 ? freshRequests.shift() : dueMetadataId : null;
    if (priorityRequestId !== null) metadataRetries.delete(priorityRequestId);
    const extraTurn = prioritized && stages[stageIndex] !== 'tickRequests';
    if (!extraTurn) stageIndex = (stageIndex + 1) % stages.length;
    priorityServed = extraTurn;
    activeStage = stage.slice(4).toLowerCase();
    let workerFailed = false;
    try {
      if (stage === 'tickRequests' && requestRunning) {
        lastResult = { state: 'idle' };
      } else if (stage === 'tickRequests') {
        requestRunning = Promise.resolve().then(() => pipeline[stage](
          priorityRequestId === null ? undefined : { priorityRequestId }))
          .then((result) => { lastResult = result; recordRequestResult(result); })
          .catch(() => { lastResult = { state: 'held',
            reason: 'worker_unavailable' }; })
          .finally(() => { requestRunning = undefined; });
      } else {
        lastResult = await pipeline[stage](priorityRequestId === null
          ? undefined : { priorityRequestId });
      }
    }
    catch { workerFailed = true;
      lastResult = { state: 'held', reason: 'worker_unavailable' }; }
    lastStage = activeStage;
    activeStage = null;
    // Retry unresolved crash claims after a complete stage cycle. Their
    // queue rows stay excluded, but they cannot stall independent work.
    if (!extraTurn && stageIndex === 0 && reviewHeld) {
      try {
        const checked = await pipeline.initialize();
        reviewHeld = checked?.state !== 'reconciled' || hasReviewHolds(checked);
      } catch { reviewHeld = true; }
      recoveryState = reviewHeld ? 'waiting_with_review' : 'waiting';
    }
    const finished = now();
    lastFinishedMs = Number.isSafeInteger(finished) && finished >= 0
      ? finished : null;
    // A durable worker may hold one target while later targets remain ready.
    // Reserve the longer backoff for an actual worker failure.
    const nextMetadataMs = metadataRetries.size > 0
      ? Math.min(...metadataRetries.values()) : null;
    const metadataDelayMs = nextMetadataMs === null ? stepDelayMs :
      Math.max(1_000, nextMetadataMs - finished);
    schedule(workerFailed ? failureDelayMs : Math.min(stepDelayMs,
      freshRequests.length > 0 && !priorityServed ? 1_000 :
        nextMetadataMs !== null && nextMetadataMs <= finished &&
        !priorityServed ? 1_000 : metadataDelayMs));
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
        reviewHeld = result?.state === 'reconciled' && hasReviewHolds(result);
        recoveryState = result?.state === 'reconciled'
          ? reviewHeld ? 'waiting_with_review' : 'waiting' : 'reconciliation_held';
        if (result?.state === 'reconciled') {
          if (Array.isArray(result.resumedRequests)) {
            for (const id of result.resumedRequests) {
              if (Number.isSafeInteger(id) && id > 0 &&
                  !freshRequests.includes(id) && freshRequests.length < 32) {
                freshRequests.push(id);
              }
            }
          }
          if (typeof pipeline.listMetadataRetries === 'function') {
            for (const row of pipeline.listMetadataRetries()) {
              if (Number.isSafeInteger(row.requestId) && row.requestId > 0 &&
                  Number.isSafeInteger(row.nextDueMs) && row.nextDueMs >= 0) {
                metadataRetries.set(row.requestId, row.nextDueMs);
              }
            }
          }
          const soonest = metadataRetries.size > 0
            ? Math.min(...metadataRetries.values()) : null;
          schedule(freshRequests.length > 0 ? 1_000 : soonest === null
            ? initialDelayMs : Math.min(initialDelayMs,
              Math.max(1_000, soonest - now())));
        }
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
    wakeRequest(requestId) {
      if (!Number.isSafeInteger(requestId) || requestId < 1) {
        throw new TypeError('Invalid fresh request ID');
      }
      if (closed) return;
      const queued = freshRequests.indexOf(requestId);
      if (queued >= 0) freshRequests.splice(queued, 1);
      else if (freshRequests.length >= 32) freshRequests.pop();
      // A submitted request must lead restart-recovered backlog. Any displaced
      // saved row remains durable and will be found by the ordinary cursor.
      freshRequests.unshift(requestId);
      metadataRetries.delete(requestId);
      if (timer !== undefined && recoveryState.startsWith('waiting') &&
          !priorityServed) {
        clearTimer(timer);
        schedule(1_000);
      }
    },
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
          if (requestRunning) await Promise.allSettled([requestRunning]);
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
