import { realpath } from 'node:fs/promises';
import { createMountInspector } from './docker-mount-witness.mjs';

// Account-server startup boundary. Configuration parsing rejects incomplete
// opt-ins; this function still refuses to schedule a worker until its durable
// journals reconcile. Disabled startup never constructs a witness client.
export async function startAcquisitionRuntime({ config, service, sessionGate,
  makeInspector = createMountInspector, realpathImpl = realpath } = {}) {
  if (config?.acquisitionRuntime !== true) return null;
  const a = config.acquisition;
  if (!a || typeof service?.openAcquisitionWorkers !== 'function' ||
      typeof makeInspector !== 'function' || typeof realpathImpl !== 'function') {
    throw new TypeError('Acquisition startup unavailable');
  }
  const runtime = service.openAcquisitionWorkers({
    qbBaseUrl: config.qbitSidecar?.baseUrl, sessionGate,
    stagingHostPath: a.stagingHostPath, holdingRoot: a.holdingRoot,
    importRoot: a.importRoot,
    inspectMounts: makeInspector({ socketPath: a.mountWitnessSocket }),
    realpathImpl, shokoProviderId: a.shokoProviderId,
  });
  try {
    const result = await runtime.start();
    // A held scheduler keeps acquisition idle and retries reconciliation.
    // The request site can still serve catalogue and existing request history.
    if (!['reconciled', 'held'].includes(result?.state)) {
      throw new Error('Acquisition journal reconciliation incomplete');
    }
  } catch (error) {
    try { await runtime.stop?.(); } catch { /* Preserve startup failure. */ }
    throw error;
  }
  return runtime;
}
