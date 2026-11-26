import { openQualityInspectionRetry } from './quality-inspection-retry.mjs';
import { createAcquisitionStageProcessors } from
  './acquisition-stage-processors.mjs';
import { openAcquisitionPipeline } from './acquisition-pipeline.mjs';
import { createPipelineScheduler } from './acquisition-pipeline-scheduler.mjs';

// Disabled construction is intentionally inert, including database access.
// The account server can opt in only with every configured guard present;
// source wiring alone is not installed evidence or deployment approval.
export function openAcquisitionRuntime(options = {}) {
  if (typeof options?.enabled !== 'boolean') {
    throw new TypeError('Explicit acquisition runtime flag required');
  }
  if (!options.enabled) return {
    start: async () => ({ state: 'held', reason: 'runtime_disabled' }),
    stop: async () => {},
    wakeRequest: () => {},
    wakeHydratedTitle: () => [],
    getStatus: () => ({ state: 'disabled' }),
  };
  const { dbPath, acquisitions, recognitionRecoveries, shokoRescans, qbBaseUrl,
    sessionGate, allowedAnidbIds,
    ownershipGate = null,
    fetchImpl = fetch, now = Date.now, ...providers } = options;
  const qualityInspectionRetry = openQualityInspectionRetry(dbPath);
  const stages = createAcquisitionStageProcessors({ qualityInspectionRetry,
    ...providers, acquisitions, recognitionRecoveries, shokoRescans,
    ownershipGate,
    providerFetchImpl: fetchImpl, now });
  const pipeline = openAcquisitionPipeline({ dbPath, acquisitions,
    recognitionRecoveries, shokoRescans,
    holdingRoot: providers.holdingRoot,
    qbBaseUrl, sessionGate, allowedAnidbIds, ownershipGate,
    fetchImpl, now, pureMode: providers.pureMode === true,
    // Give completed imports a turn between each potentially two-minute
    // first-time request check. The four stages remain strictly serial.
    requestPageLimit: 1, ...stages });
  const scheduler = createPipelineScheduler({ pipeline, now });
  let stopPromise;
  return { start: () => scheduler.start(),
    stop: () => stopPromise ??= (async () => { await scheduler.stop(); qualityInspectionRetry.close(); })(),
    wakeRequest: (requestId) => {
      const request = providers.requests?.getRequest(requestId);
      if (request) providers.discoverCandidates?.invalidateTitle?.(request.anidbId);
      pipeline.wakeRequest({ requestId, nowMs: now() });
      scheduler.wakeRequest(requestId);
    },
    wakeHydratedTitle: (anidbId) => {
      const ids = pipeline.wakeHydratedTitle({ anidbId, nowMs: now() });
      for (const id of ids) scheduler.wakeRequest(id);
      return ids;
    },
    getStatus: () => scheduler.getStatus() };
}

