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
  const result = await runtime.start();
  if (result?.state !== 'reconciled') {
    await runtime.stop?.();
    throw new Error('Acquisition journal reconciliation incomplete');
  }
  return runtime;
}
