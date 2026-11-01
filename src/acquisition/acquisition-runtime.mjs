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
    getStatus: () => ({ state: 'disabled' }),
  };
  const { dbPath, acquisitions, qbBaseUrl, sessionGate,
    fetchImpl = fetch, now = Date.now, ...providers } = options;
  const stages = createAcquisitionStageProcessors({
    ...providers, acquisitions, providerFetchImpl: fetchImpl, now });
  const pipeline = openAcquisitionPipeline({ dbPath, acquisitions,
    qbBaseUrl, sessionGate, fetchImpl, now, ...stages });
  const scheduler = createPipelineScheduler({ pipeline, now });
  return { start: () => scheduler.start(),
    stop: () => scheduler.stop(),
    getStatus: () => scheduler.getStatus() };
}
