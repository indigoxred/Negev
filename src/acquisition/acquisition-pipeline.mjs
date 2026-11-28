import { closeInOrder } from '../runtime/close-in-order.mjs';
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
  processRecovery, processRescan, processBonus,
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
  const running = { request: false, media: false, bonus: false };
  // Optional bonus files are observed one at a time. A bonus whose check
  // could not save a later due time (for example a plan conflict, or a
  // journal error) would otherwise stay first in line and starve the rest,
  // so skip any bonus this process already tried within the last minute.
  const BONUS_RETRY_MS = 60_000;
  const triedBonuses = new Map();
  const bonusWorker = typeof processBonus === 'function' &&
    typeof acquisitions.listPendingBonuses === 'function' ? {
      runOnce: async () => {
        const nowMs = now();
        for (const [key, triedMs] of triedBonuses) {
          if (nowMs - triedMs >= BONUS_RETRY_MS || nowMs < triedMs) triedBonuses.delete(key);
        }
        const key = (item) => `${item.attemptId}\u0000${item.name}`;
        const item = acquisitions.listPendingBonuses({ nowMs, limit: 20 })
          .find((candidate) => !triedBonuses.has(key(candidate)));
        if (!item) return { state: 'idle' };
        triedBonuses.set(key(item), nowMs);
        return processBonus({ item });
      },
    } : null;
  let holdingRecovered = false;
  let recoveryAfterId = 0;
  let preferRecognitionRecovery = false;
  let preferUrgentRescan = true;
  const withLane = async (lane, previous, action) => {
    if (running[lane]) {
      return { state: 'deferred', resolved: [],
        held: Array.isArray(previous?.held) ? previous.held : [] };
    }
    running[lane] = true;
    try { return await action(); } finally { running[lane] = false; }
  };
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
  // Pure mode only renames selected files; the legacy hashing/copy path stays
  // one attempt per turn. Serialize claims and preserve stage fairness even
  // when a backlog is large or a provider is failing.
  const runMediaBatch = async (worker, afterEach = () => {}) => {
    const beganMs = now();
    const results = [];
    const limit = pureMode ? 10 : 1;
    for (let index = 0; index < limit; index++) {
      if (closed && index > 0) break;
      const result = await worker.runOnce();
      if (result?.state !== 'processed') return results.length > 0
        ? { ...results.at(-1), processedCount: results.length, results } : result;
      results.push(result);
      await afterEach(result);
      if (now() - beganMs >= 5_000 ||
          ['provider_http_error', 'provider_http_403', 'provider_timeout',
            'provider_transport', 'provider_invalid_response', 'provider_unavailable',
            'authentication_unavailable', 'authentication_backoff',
            'stop_outcome_unknown', 'torrent_unavailable', 'torrent_unavailable_after_stop']
            .includes(result.result?.reason)) break;
    }
    return results.length === 1 ? results[0] :
      { ...results.at(-1), processedCount: results.length, results };
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
          // An unfinished claim is only a crash leftover when its lane is not
          // running. A repeated reconciliation can happen while the scheduler
          // has a live request search, so hold that lane for the duration and
          // skip it, keeping its earlier holds, when it is already in use.
          const previous = recovery;
          let resumedRequests = [];
          const requests = await withLane('request', previous?.requests,
            async () => {
              const reviewed = await reconcileUnresolvedAcquisitionClaims({
                queue: requestQueue, now,
                inspectRequest: (requestId) =>
                  acquisitions.inspectRequestAttempts(requestId),
              });
              resumedRequests = requestQueue.resumeObservedAttemptHolds({
                nowMs: now() });
              return reviewed;
            });
          const starts = await withLane('media', previous?.starts,
            () => startQueue.reconcileUnresolved({ nowMs: now() }));
          const completions = await withLane('media', previous?.completions,
            () => completionQueue.reconcileUnresolved({ nowMs: now() }));
          const publishes = await withLane('media', previous?.publishes,
            () => publishQueue.reconcileUnresolved({ nowMs: now() }));
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
    wakeRequest: (input) => closed ? held('pipeline_closed') :
      requestQueue.wakePreferredGroupWait(input),
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
      if(bonusWorker)void run(bonusWorker,'bonus').catch(()=>{});
      return runMediaBatch(completionWorker, async (result) => {
        if (result?.result?.reason === 'media_retired' &&
            Number.isSafeInteger(result.attemptId)) {
          const attempt = acquisitions.getAttempt(result.attemptId);
          if (Number.isSafeInteger(attempt?.requestId)) {
            requestQueue.wakeAfterMediaRetirement({
              requestId: attempt.requestId, nowMs: now() });
          }
        }
      });
    } }),
    tickPublish: () => run({ runOnce: () => runMediaBatch(publishWorker) }),
    beginShutdown() { closed = true; },
    close() {
      if (!closing) {
        closed = true;
        closing = (async () => {
          if (initialization) await Promise.allSettled([initialization]);
          await Promise.allSettled([...active]);
          await closeInOrder([...queues].reverse().map((queue,index)=>[`acquisition queue ${index}`,()=>queue.close()]));
        })();
      }
      return closing;
    },
  };
}

