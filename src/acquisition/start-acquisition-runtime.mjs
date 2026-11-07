import { realpath } from 'node:fs/promises';
import { verifyLocalStagingRoot } from './local-staging-root.mjs';
import { ensureImportChild } from './ensure-import-child.mjs';
import { verifyShokoSourceFolder } from './shoko-source-folder.mjs';

// Account-server startup boundary. Configuration parsing rejects incomplete
// opt-ins; this function reviews durable journals before scheduling workers.
// Unresolved claims stay excluded while independent work can continue.
// Disabled startup never touches the acquisition filesystem.
export async function startAcquisitionRuntime({ config, service, sessionGate,
  shokoApiKey,
  verifyRoot = verifyLocalStagingRoot, ensureChild = ensureImportChild,
  verifySource = verifyShokoSourceFolder,
  realpathImpl = realpath } = {}) {
  if (config?.acquisitionRuntime !== true) return null;
  const a = config.acquisition;
  if (!a || typeof service?.openAcquisitionWorkers !== 'function' ||
      typeof verifyRoot !== 'function' || typeof ensureChild !== 'function' ||
      typeof verifySource !== 'function' ||
      typeof realpathImpl !== 'function') {
    throw new TypeError('Acquisition startup unavailable');
  }
  const verifyShokoSource = () => verifySource({ baseUrl: config.shokoBaseUrl,
    apiKey: shokoApiKey, folderId: a.shokoSourceFolderId,
    shokoPath: a.shokoSourcePath });
  const runtime = service.openAcquisitionWorkers({
    qbBaseUrl: config.qbitSidecar?.baseUrl, sessionGate,
    stagingHostPath: a.stagingHostPath, qbitStagingRoot: a.qbitStagingRoot,
    holdingRoot: a.holdingRoot,
    importRoot: a.importRoot,
    ...(a.provisionalFallback === true ? {
      provisionalFallback: true, shokoSourcePath: a.shokoSourcePath } : {}),
    verifyShokoSource,
    verifyStagingRoot: async () => {
      const source = await verifyShokoSource();
      if (source?.state !== 'verified_shoko_source') {
        return { state: 'held', reason: 'shoko_source_unverified' };
      }
      const ready = await ensureChild({ holdingRoot: a.holdingRoot,
        importRoot: a.importRoot });
      return ready?.state === 'import_child_ready'
        ? verifyRoot({ stagingRoot: a.stagingHostPath,
          holdingRoot: a.holdingRoot, importRoot: a.importRoot })
        : { state: 'held', reason: 'import_child_unavailable' };
    },
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
