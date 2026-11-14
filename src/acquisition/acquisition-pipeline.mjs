import { openAcquisitionRequestQueue, createAcquisitionPageWorker,
  reconcileUnresolvedAcquisitionClaims } from './acquisition-request-queue.mjs';
import { openStartQueue, createStartWorker } from './start-queue.mjs';
import { openCompletionQueue, createCompletionWorker } from './completion-queue.mjs';
import { openHandoffPublishQueue, createHandoffPublishWorker } from
  './handoff-publish-queue.mjs';
import { createAcquisitionSessionRunners } from
  './acquisition-session-runners.mjs';
import { recoverOrphanedHolding } from './orphaned-holding-recovery.mjs';

const held = (reason) => ({ state: 'held', reason });

// Source-only composition of the four existing durable queues. It exposes
// explicit ticks, not a timer or HTTP route. Only one stage may run at a time
// to bound concurrent media reads. A caller must supply guarded processors
// and finish restart reconciliation before any tick can run.
export function openAcquisitionPipeline({ dbPath, acquisitions, holdingRoot,
  processRequest, processStart, processCompletion, processPublish,
  qbBaseUrl, sessionGate, allowedAnidbIds = null, ownershipGate = null,
  fetchImpl = fetch, now = Date.now, pureMode = false,
  requestPageLimit = 3 } = {}) {
  if (typeof dbPath !== 'string' || !dbPath ||
      typeof acquisitions?.inspectRequestAttempts !== 'function' ||
      !Number.isSafeInteger(requestPageLimit) || requestPageLimit < 1 ||
      requestPageLimit > 3 ||
      [processRequest, processStart, processCompletion, processPublish, now]
        .some((fn) => typeof fn !== 'function')) {
    throw new TypeError('Invalid acquisition pipeline');
  }
  const sessionRunners = createAcquisitionSessionRunners({ qbBaseUrl,
    sessionGate, fetchImpl, processRequest, processStart,
    processCompletion, processPublish });
  const queues = [];
  try {
    queues.push(openAcquisitionRequestQueue(dbPath, {
      allowedAnidbIds, ownershipGate }));
    queues.push(openStartQueue(dbPath));
    queues.push(openCompletionQueue(dbPath, { pureMode }));
    queues.push(openHandoffPublishQueue(dbPath, { pureMode }));
  } catch (error) {
    for (const queue of queues.reverse()) queue.close();
    throw error;
  }
  const [requestQueue, startQueue, completionQueue, publishQueue] = queues;
  const requestWorker = createAcquisitionPageWorker({ queue: requestQueue,
    processRequest: sessionRunners.processRequest, now,
    limit: requestPageLimit });
  const startWorker = createStartWorker({ queue: startQueue,
    processAttempt: sessionRunners.processStart, now });
  const completionWorker = createCompletionWorker({ queue: completionQueue,
    processAttempt: sessionRunners.processCompletion, now });
  const publishWorker = createHandoffPublishWorker({ queue: publishQueue,
    processAttempt: sessionRunners.processPublish, now });
  const active = new Set();
  let initialization;
  let recovery;
  let closed = false;
  let closing;
  let running = false;
  let holdingRecovered = false;
  const run = (worker) => {
    if (closed) return Promise.resolve(held('pipeline_closed'));
    if (!recovery) return Promise.resolve(held('reconciliation_required'));
    if (running) return Promise.resolve(held('pipeline_busy'));
    running = true;
    const task = Promise.resolve().then(() => worker.runOnce());
    active.add(task);
    void task.finally(() => {
      active.delete(task);
      running = false;
    }).catch(() => {});
    return task;
  };
  return {
    initialize() {
      if (closed) return Promise.resolve(held('pipeline_closed'));
      if (recovery && [recovery.requests, recovery.starts,
        recovery.completions, recovery.publishes]
        .every((result) => result.held.length === 0)) return Promise.resolve(recovery);
      if (!initialization) {
        initialization = (async () => {
          if (holdingRoot && !holdingRecovered) {
            await recoverOrphanedHolding({ holdingRoot, dbPath });
            holdingRecovered = true;
          }
          const requests = await reconcileUnresolvedAcquisitionClaims({
            queue: requestQueue, now,
            inspectRequest: (requestId) =>
              acquisitions.inspectRequestAttempts(requestId),
          });
          const starts = startQueue.reconcileUnresolved({ nowMs: now() });
          const completions = completionQueue.reconcileUnresolved({ nowMs: now() });
          const publishes = publishQueue.reconcileUnresolved({ nowMs: now() });
          // Each queue excludes its own unresolved claims. Keep those claims
          // for review while independent items continue through the workers.
          recovery = { state: 'reconciled', requests, starts,
            completions, publishes };
          return recovery;
        })().finally(() => { initialization = undefined; });
      }
      return initialization;
    },
    tickRequests: () => run({ runOnce: async () => {
      if (ownershipGate) {
        const result = await ownershipGate.refresh();
        if (result?.state !== 'ready') return held('sonarr_ownership_unavailable');
      }
      return requestWorker.runOnce();
    } }),
    tickStarts: () => run(startWorker),
    tickCompletions: () => run(completionWorker),
    tickPublish: () => run(publishWorker),
    close() {
      if (!closing) {
        closed = true;
        closing = (async () => {
          if (initialization) await Promise.allSettled([initialization]);
          await Promise.allSettled([...active]);
          for (const queue of [...queues].reverse()) queue.close();
        })();
      }
      return closing;
    },
  };
}

