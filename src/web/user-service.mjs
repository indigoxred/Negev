import { openAccountLedger } from '../auth/account-ledger.mjs';
import { openRequestLedger } from '../requests/request-ledger.mjs';
import { openRequestProgress } from '../requests/request-progress.mjs';
import { openAcquisitionLedger } from '../acquisition/acquisition-ledger.mjs';
import { openHandoffLedger } from '../acquisition/handoff-ledger.mjs';
import { createHeldRequestSubmitter } from '../requests/submit-held-request.mjs';
import { openHydrationLedger } from '../catalogue/hydration-ledger.mjs';
import { createObservedTitleRegistry } from '../catalogue/observed-title-registry.mjs';
import { createCatalogueHydrator } from '../catalogue/catalogue-hydrator.mjs';
import { searchAniDbTitles } from '../catalogue/shoko-search.mjs';
import { readAniDbRelatedTitles } from '../catalogue/shoko-related-titles.mjs';
import { loadAniDbDetail } from '../catalogue/shoko-detail.mjs';
import { requestAniDbHydration } from '../catalogue/shoko-hydration.mjs';
import { collectAniDbDetail } from '../catalogue/collect-detail.mjs';
import { pollAiringWatches } from '../requests/airing-watch-poll.mjs';
import { createAiringPageWorker } from '../requests/airing-page-worker.mjs';
import { buildUserApp } from './user-app.mjs';
import { createMetadataLimiter } from './metadata-limiter.mjs';
import { readShokoFilePage } from '../availability/shoko-file-page.mjs';
import { readShokoOneFile } from '../availability/shoko-one-file.mjs';
import { createShokoEventConsumer } from '../availability/shoko-event-consumer.mjs';
import { createShokoInventoryWorker, openShokoInventoryLedger } from
  '../availability/shoko-inventory-worker.mjs';
import { createPlexAvailabilityService } from
  '../availability/plex-availability-service.mjs';
import { openDirectAvailabilityQueue, createDirectAvailabilityWorker } from
  '../availability/direct-availability-queue.mjs';
import { createRequestCandidateDiscovery } from
  '../acquisition/request-candidate-discovery.mjs';
import { searchReleaseCandidates } from '../acquisition/prowlarr-search.mjs';
import { previewRequestCandidate } from '../acquisition/request-candidate-preflight.mjs';
import { prepareStoppedCandidate } from '../acquisition/prepare-stopped-candidate.mjs';
import { probeTargetPresence } from '../acquisition/probe-target-presence.mjs';
import { readShokoEpisodeFiles } from '../availability/shoko-episode-files.mjs';
import { readShokoImportActivity } from '../availability/shoko-import-activity.mjs';

// Account-backed catalogue and held requests. No acquisition dispatch or
// public Plex availability is connected until their installed gates pass.
export async function createUserService({ dbPath, shokoBaseUrl, shokoApiKey,
  sessionKey, publicOrigin, secureCookies = true, shokoHydration = false,
  plex = null, prowlarr = null, fetchImpl = fetch,
  onShokoReconciliationNeeded,
  now = Date.now, today = () => new Date().toISOString().slice(0, 10) } = {}) {
  if (typeof dbPath !== 'string' || !dbPath ||
      typeof shokoBaseUrl !== 'string' || !shokoBaseUrl ||
      typeof shokoApiKey !== 'string' || !shokoApiKey ||
      typeof fetchImpl !== 'function' || typeof now !== 'function' ||
      typeof today !== 'function' || typeof shokoHydration !== 'boolean' ||
      (onShokoReconciliationNeeded !== undefined &&
        typeof onShokoReconciliationNeeded !== 'function') ||
      (prowlarr !== null && (typeof prowlarr?.baseUrl !== 'string' ||
        typeof prowlarr.apiKey !== 'string' || !prowlarr.apiKey ||
        !Array.isArray(prowlarr.indexerIds) ||
        prowlarr.indexerIds.length < 1 || prowlarr.indexerIds.length > 20))) {
    throw new TypeError('Invalid user service configuration');
  }
  let accounts;
  let requests;
  let acquisitions;
  let handoffs;
  let progress;
  let hydration;
  let inventory;
  let directAvailability;
  let plexObserver;
  try {
    accounts = openAccountLedger(dbPath, { now });
    requests = openRequestLedger(dbPath);
    acquisitions = openAcquisitionLedger(dbPath);
    handoffs = openHandoffLedger(dbPath);
    progress = openRequestProgress(dbPath);
    hydration = openHydrationLedger(dbPath);
    inventory = openShokoInventoryLedger(dbPath);
    directAvailability = openDirectAvailabilityQueue(dbPath);
    const metadata = createMetadataLimiter();
    if (plex) plexObserver = createPlexAvailabilityService({ dbPath,
      shokoBaseUrl, shokoApiKey, ...plex, fetchImpl, now });
    const enqueueChangedFile = ({ before, after, observedMs,
      priority = 'reconcile' }) => {
      const pairs = new Map();
      for (const pair of [...(before?.pairs ?? []), ...(after?.pairs ?? [])]) {
        pairs.set(`${pair.anidbId}:${pair.episodeId}`, pair);
      }
      for (const pair of pairs.values()) {
        const previous = directAvailability.getObservation(pair);
        directAvailability.enqueue({ ...pair,
          observedMs: Math.max(observedMs, (previous?.observedMs ?? -1) + 1),
          priority });
      }
    };
    const inventoryWorker = createShokoInventoryWorker({ ledger: inventory, now,
      onChangedFile: enqueueChangedFile,
      readPage: (input) => metadata.run(() => readShokoFilePage({
        baseUrl: shokoBaseUrl, apiKey: shokoApiKey, ...input, fetchImpl,
      })) });
    const titleRegistry = createObservedTitleRegistry({ now });
    const loadDetail = ({ anidbId, page }) => loadAniDbDetail({
      baseUrl: shokoBaseUrl, apiKey: shokoApiKey, anidbId, page, fetchImpl,
    });
    const observeCurrentPublic = (target, observedShoko) => {
      if (directAvailability.getObservation(target) &&
          inventory.getObservedFileIds(target).length === 0) {
        return Promise.resolve({ state: 'unknown', reason: 'shoko_identity_changed' });
      }
      return metadata.run(() => plexObserver.observeTarget(target,
        observedShoko));
    };
    const directWorker = createDirectAvailabilityWorker({ queue: directAvailability,
      now, observeTarget: async (target) => {
        if (!plexObserver) return { state: 'unknown' };
        if (inventory.getObservedFileIds(target).length === 0) {
          return { state: 'unknown' };
        }
        const detail = await metadata.run(() => loadDetail({
          anidbId: target.anidbId, page: 1 }));
        if (detail?.state !== 'details') return { state: 'unknown' };
        return observeCurrentPublic({ ...target, kind: detail.kind });
      } });
    const hydrator = createCatalogueHydrator({
      isKnownTitle: (input) => titleRegistry.isKnownTitle(input),
      loadDetail, ledger: hydration, now,
      requestHydration: ({ anidbId }) => requestAniDbHydration({
        baseUrl: shokoBaseUrl, apiKey: shokoApiKey, anidbId, fetchImpl,
      }),
    });
    const submitRequest = createHeldRequestSubmitter({
      titleRegistry, loadDetail, ledger: requests, now, today,
    });
    const discoverCandidates = prowlarr ? createRequestCandidateDiscovery({
      readRequest: (id) => requests.getRequest(id),
      loadDetail: (input) => metadata.run(() => loadDetail(input)),
      searchReleases: ({ query }) => metadata.run(() => searchReleaseCandidates({
        baseUrl: prowlarr.baseUrl, apiKey: prowlarr.apiKey,
        indexerIds: prowlarr.indexerIds, query, fetchImpl })),
    }) : undefined;
    const previewCandidate = prowlarr ? ({ requestId, candidate }) =>
      previewRequestCandidate({ requestId, candidate,
        readRequest: (id) => requests.getRequest(id),
        loadDetail: (input) => metadata.run(() => loadDetail(input)),
        prepare: (input) => metadata.run(() => prepareStoppedCandidate({
          baseUrl: prowlarr.baseUrl, apiKey: prowlarr.apiKey,
          indexerIds: prowlarr.indexerIds, ...input, fetchImpl,
        })),
      }) : undefined;
    const airingWorker = createAiringPageWorker({ ledger: requests,
      pollPage: ({ afterId, limit }) => pollAiringWatches({
        ledger: requests, afterId, limit, today: today(),
        loadDetail: ({ anidbId }) => collectAniDbDetail({ anidbId,
          loadPage: async ({ page }) => {
            if (page > 1) await new Promise((resolve) => setTimeout(resolve, 250));
            return metadata.run(() => loadDetail({ anidbId, page }));
          },
        }),
      }),
    });
    const app = await buildUserApp({ accounts, sessionKey, publicOrigin, secureCookies,
      publicAvailabilityConfigured: Boolean(plexObserver),
      now, submitRequest: (input) => metadata.run(() => submitRequest(input)),
      readRequest: (id) => requests.getRequest(id),
      listRequests: (input) => {
        const page = requests.listRequests(input);
        return { ...page, items: page.items.map((item) => {
          const local = progress.read(item.id);
          const coverage = plexObserver ? directAvailability.getCoverage({
            anidbId: item.anidbId, episodeIds: item.episodeIds,
            nowMs: now() }) : null;
          return { ...item, progress: coverage?.verifiedTargets > 0
            ? { ...local, publicAvailability: 'verified_recently',
              publicVerifiedTargets: coverage.verifiedTargets }
            : local };
        }) };
      },
      searchTitles: ({ query, page }) => metadata.run(() => searchAniDbTitles({
        baseUrl: shokoBaseUrl, apiKey: shokoApiKey, query, page, fetchImpl,
      })),
      loadRelatedTitles: ({ anidbId }) => metadata.run(() =>
        readAniDbRelatedTitles({ baseUrl: shokoBaseUrl, apiKey: shokoApiKey,
          anidbId, fetchImpl })),
      titleRegistry, loadDetail: async (input) => {
        const detail = await metadata.run(() => loadDetail(input));
        if (!plexObserver || detail?.state !== 'details' ||
            !Array.isArray(detail.episodes) || detail.episodes.length > 100) return detail;
        return { ...detail, episodes: detail.episodes.map((episode) => ({
          ...episode, availability: directAvailability.getStatus({
            anidbId: detail.anidbId, episodeId: episode.id,
            nowMs: now() }).state,
        })) };
      },
      discoverCandidates, previewCandidate,
      probeRequestTargets: plexObserver ? ({ request, episodeIds }) =>
        probeTargetPresence({ anidbId: request.anidbId,
          kind: request.kind, episodeIds, now,
          readImportActivity: () => metadata.run(() =>
            readShokoImportActivity({ baseUrl: shokoBaseUrl,
              apiKey: shokoApiKey, fetchImpl })),
          readShokoEpisode: (target) => metadata.run(() =>
            readShokoEpisodeFiles({ baseUrl: shokoBaseUrl,
              apiKey: shokoApiKey, ...target, fetchImpl })),
          readPublicTarget: (target, observedShoko) =>
            observeCurrentPublic(target, observedShoko),
        }) : undefined,
      hydrateTitle: shokoHydration ?
        (input) => metadata.run(() => hydrator.load(input)) : undefined,
      observePublicTarget: (target) => plexObserver ?
        observeCurrentPublic(target) :
        { state: 'unknown', reason: 'observer_not_configured' },
    });
    const observations = new Set();
    let stopping = false;
    let stopPromise;
    const track = (task) => {
      observations.add(task);
      void task.then(() => observations.delete(task), () => observations.delete(task));
      return task;
    };
    const refreshShokoFile = (fileId) => {
      if (stopping) return Promise.resolve({ state: 'held', reason: 'service_stopping' });
      if (!Number.isSafeInteger(fileId) || fileId < 1) {
        return Promise.resolve({ state: 'held', reason: 'invalid_file_id' });
      }
      return track((async () => {
        const before = inventory.getFile(fileId);
        const result = await metadata.run(() => readShokoOneFile({
          baseUrl: shokoBaseUrl, apiKey: shokoApiKey, fileId, fetchImpl,
        }));
        if (result?.state !== 'file') return { state: 'held', reason: 'file_unavailable' };
        const observedMs = now();
        const saved = inventory.recordFileObservation({ item: result.item, observedMs });
        const after = inventory.getFile(fileId);
        if (saved.state === 'recorded_file' && after?.observedMs === observedMs &&
            (before?.updated !== after.updated || before?.state !== after.state ||
             JSON.stringify(before?.pairs) !== JSON.stringify(after.pairs))) {
          enqueueChangedFile({ before, after, observedMs, priority: 'event' });
        }
        return saved;
      })());
    };
    const eventConsumer = createShokoEventConsumer({ refreshFile: refreshShokoFile,
      onReconciliationNeeded: onShokoReconciliationNeeded,
      onDeleted: (fileId) => {
        const before = inventory.getFile(fileId);
        if (before?.pairs.length) enqueueChangedFile({ before, after: null,
          observedMs: now(), priority: 'event' });
      } });
    return { app,
      pollAiringNextPage: () => {
        if (stopping) return Promise.resolve({ state: 'held', reason: 'service_stopping' });
        return track(airingWorker.runOnce());
      },
      tickShokoInventory: () => {
        if (stopping) return Promise.resolve({ state: 'held', reason: 'service_stopping' });
        return track(inventoryWorker.tick());
      },
      tickDirectAvailability: () => {
        if (stopping) return Promise.resolve({ state: 'held', reason: 'service_stopping' });
        if (!plexObserver) return Promise.resolve({ state: 'held',
          reason: 'observer_not_configured' });
        return track(directWorker.runOnce());
      },
      getDirectAvailabilityStatus: (target) => directAvailability.getStatus({
        ...target, nowMs: now() }),
      tickPublicPlexPage: (input) => {
        if (stopping) return Promise.resolve({ state: 'held', reason: 'service_stopping' });
        if (!plexObserver) return Promise.resolve({ state: 'held',
          reason: 'observer_not_configured' });
        return track(metadata.run(() => plexObserver.tick(input)));
      },
      tickPublicPlexRecent: (input) => {
        if (stopping) return Promise.resolve({ state: 'held', reason: 'service_stopping' });
        if (!plexObserver) return Promise.resolve({ state: 'held',
          reason: 'observer_not_configured' });
        return track(metadata.run(() => plexObserver.scanRecent(input)));
      },
      observePublicTarget: (target) => {
        if (stopping) return Promise.resolve({ state: 'unknown',
          reason: 'service_stopping' });
        if (!plexObserver) return Promise.resolve({ state: 'unknown',
          reason: 'observer_not_configured' });
        return track(observeCurrentPublic(target));
      },
      refreshShokoFile,
      acceptShokoEvent: (target, args) => eventConsumer.accept(target, args),
      flagShokoReconciliation: (reason) => eventConsumer.flagReconciliation(reason),
      getShokoEventState: () => eventConsumer.getState(),
      getObservedShokoFileIds: (input) => inventory.getObservedFileIds(input),
      close() {
        if (!stopPromise) {
          stopping = true;
          stopPromise = (async () => {
            try { await app.close(); }
            finally {
              await eventConsumer.close();
              await Promise.allSettled([...observations]);
              plexObserver?.close();
              directAvailability.close();
              inventory.close(); hydration.close(); progress.close();
              handoffs.close(); acquisitions.close(); requests.close(); accounts.close();
            }
          })();
        }
        return stopPromise;
      } };
  } catch (error) {
    plexObserver?.close(); directAvailability?.close(); inventory?.close(); hydration?.close();
    progress?.close(); handoffs?.close(); acquisitions?.close();
    requests?.close(); accounts?.close();
    throw error;
  }
}
