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
// explicit ticks, not a timer or HTTP route. Media stages serialize their
// full-file reads; a request search has its own lane and cannot hold a
// completed transfer behind remote indexer calls. A caller must supply guarded processors
// and finish restart reconciliation before any tick can run.
export function openAcquisitionPipeline({ dbPath, acquisitions, holdingRoot,
  recognitionRecoveries = null, shokoRescans = null,
  processRequest, processStart, processCompletion, processPublish,
  processRecovery, processRescan,
  qbBaseUrl, sessionGate, allowedAnidbIds = null, ownershipGate = null,
  fetchImpl = fetch, now = Date.now, pureMode = false,
  requestPageLimit = 3 } = {}) {
  if (typeof dbPath !== 'string' || !dbPath ||
      typeof acquisitions?.inspectRequestAttempts !== 'function' ||
      !Number.isSafeInteger(requestPageLimit) || requestPageLimit < 1 ||
      requestPageLimit > 3 ||
      [processRequest, processStart, processCompletion, processPublish, now]
        .some((fn) => typeof fn !== 'function') ||
      (recognitionRecoveries &&
        (typeof recognitionRecoveries.listPending !== 'function' ||
         typeof processRecovery !== 'function')) ||
      (shokoRescans &&
        (typeof shokoRescans.listDue !== 'function' ||
         typeof shokoRescans.isEnrolled !== 'function' ||
         typeof shokoRescans.getAttemptStatus !== 'function' ||
         typeof shokoRescans.endAttempt !== 'function' ||
         typeof processRescan !== 'function'))) {
    throw new TypeError('Invalid acquisition pipeline');
  }
  const sessionRunners = createAcquisitionSessionRunners({ qbBaseUrl,
    sessionGate, fetchImpl, processRequest, processStart,
    processCompletion, processPublish, processRecovery });
  const queues = [];
  try {
    queues.push(openAcquisitionRequestQueue(dbPath, {
      allowedAnidbIds, ownershipGate }));
    queues.push(openStartQueue(dbPath, { acquisitions }));
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
  const running = { request: false, media: false };
  let holdingRecovered = false;
  let recoveryAfterId = 0;
  let preferRecognitionRecovery = false;
  let preferUrgentRescan = true;
  const run = (worker, lane = 'media') => {
    if (closed) return Promise.resolve(held('pipeline_closed'));
    if (!recovery) return Promise.resolve(held('reconciliation_required'));
    if (running[lane]) return Promise.resolve(held('pipeline_busy'));
    running[lane] = true;
    const task = Promise.resolve().then(() => worker.runOnce());
    active.add(task);
    void task.finally(() => {
      active.delete(task);
      running[lane] = false;
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
          const resumedRequests = requestQueue.resumeObservedAttemptHolds({
            nowMs: now() });
          const starts = startQueue.reconcileUnresolved({ nowMs: now() });
          const completions = completionQueue.reconcileUnresolved({ nowMs: now() });
          const publishes = publishQueue.reconcileUnresolved({ nowMs: now() });
          // Each queue excludes its own unresolved claims. Keep those claims
          // for review while independent items continue through the workers.
          recovery = { state: 'reconciled', requests, resumedRequests, starts,
            completions, publishes };
          return recovery;
        })().finally(() => { initialization = undefined; });
      }
      return initialization;
    },
    tickRequests: ({ priorityRequestId = null } = {}) => run({ runOnce: async () => {
      if (ownershipGate) {
        const result = await ownershipGate.refresh();
        if (result?.state !== 'ready') return held('sonarr_ownership_unavailable');
      }
      const resumed = requestQueue.resumeObservedAttemptHolds({ nowMs: now() });
      return requestWorker.runOnce({ priorityRequestId:
        priorityRequestId ?? resumed[0] ?? null });
    } }, 'request'),
    wakeHydratedTitle: (input) => closed ? [] :
      requestQueue.wakeHydratedTitle(input),
    listMetadataRetries: () => closed ? [] :
      requestQueue.listMetadataRetries({ nowMs: now() }),
    tickStarts: () => run(startWorker),
    ...(recognitionRecoveries || shokoRescans ? { tickRecovery: () => run({
      runOnce: async () => {
        const due = shokoRescans?.listDue({ nowMs: now(), limit: 1,
          preferUrgent: preferUrgentRescan })[0];
        const runRescan = async () => {
          preferRecognitionRecovery = true;
          preferUrgentRescan = !preferUrgentRescan;
          if (!due.manifest) {
            shokoRescans.endAttempt({ attemptId: due.attemptId,
              review: true, nowMs: now() });
            return held('shoko_rescan_manifest_invalid');
          }
          const result = await processRescan({ item: due });
          if (result?.state === 'linked') {
            requestQueue.wakeRecognitionRecovery({
              requestId: result.requestId, nowMs: now() });
          }
          return result;
        };
        if (due && (!preferRecognitionRecovery || !recognitionRecoveries)) return runRescan();
        if (!recognitionRecoveries) return { state: 'idle' };
        let page = recognitionRecoveries.listPending({
          afterAttemptId: recoveryAfterId, limit: 20 });
        if (page.length === 0 && recoveryAfterId !== 0) {
          recoveryAfterId = 0;
          page = recognitionRecoveries.listPending({ limit: 20 });
        }
        const item = page.find((candidate) =>
          !shokoRescans?.isEnrolled(candidate.attemptId) ||
          shokoRescans.getAttemptStatus(candidate.attemptId) === 'review');
        if (!item && page.length > 0) recoveryAfterId = page.at(-1).attemptId;
        if (!item) return due ? runRescan() : { state: 'idle' };
        preferRecognitionRecovery = false;
        recoveryAfterId = item.attemptId;
        const result = await sessionRunners.processRecovery({
          attemptId: item.attemptId });
        if (result?.state === 'recovered') {
          requestQueue.wakeRecognitionRecovery({
            requestId: result.requestId, nowMs: now() });
        }
        return result;
      },
    }) } : {}),
    tickCompletions: () => run({ runOnce: async () => {
      const result = await completionWorker.runOnce();
      if (result?.result?.reason === 'media_retired' &&
          Number.isSafeInteger(result.attemptId)) {
        const attempt = acquisitions.getAttempt(result.attemptId);
        if (Number.isSafeInteger(attempt?.requestId)) {
          requestQueue.wakeAfterMediaRetirement({
            requestId: attempt.requestId, nowMs: now() });
        }
      }
      return result;
    } }),
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

