import { openAccountLedger } from '../auth/account-ledger.mjs';
import { openRequestLedger } from '../requests/request-ledger.mjs';
import { createHeldRequestSubmitter } from '../requests/submit-held-request.mjs';
import { openHydrationLedger } from '../catalogue/hydration-ledger.mjs';
import { createObservedTitleRegistry } from '../catalogue/observed-title-registry.mjs';
import { createCatalogueHydrator } from '../catalogue/catalogue-hydrator.mjs';
import { searchAniDbTitles } from '../catalogue/shoko-search.mjs';
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

// Account-backed catalogue and held requests. No acquisition dispatch or
// public Plex availability is connected until their installed gates pass.
export async function createUserService({ dbPath, shokoBaseUrl, shokoApiKey,
  sessionKey, publicOrigin, secureCookies = true, plex = null, fetchImpl = fetch,
  now = Date.now, today = () => new Date().toISOString().slice(0, 10) } = {}) {
  if (typeof dbPath !== 'string' || !dbPath ||
      typeof shokoBaseUrl !== 'string' || !shokoBaseUrl ||
      typeof shokoApiKey !== 'string' || !shokoApiKey ||
      typeof fetchImpl !== 'function' || typeof now !== 'function' ||
      typeof today !== 'function') throw new TypeError('Invalid user service configuration');
  let accounts;
  let requests;
  let hydration;
  let inventory;
  let plexObserver;
  try {
    accounts = openAccountLedger(dbPath, { now });
    requests = openRequestLedger(dbPath);
    hydration = openHydrationLedger(dbPath);
    inventory = openShokoInventoryLedger(dbPath);
    const metadata = createMetadataLimiter();
    if (plex) plexObserver = createPlexAvailabilityService({ dbPath,
      shokoBaseUrl, shokoApiKey, ...plex, fetchImpl, now });
    const inventoryWorker = createShokoInventoryWorker({ ledger: inventory, now,
      readPage: (input) => metadata.run(() => readShokoFilePage({
        baseUrl: shokoBaseUrl, apiKey: shokoApiKey, ...input, fetchImpl,
      })) });
    const titleRegistry = createObservedTitleRegistry({ now });
    const loadDetail = ({ anidbId, page }) => loadAniDbDetail({
      baseUrl: shokoBaseUrl, apiKey: shokoApiKey, anidbId, page, fetchImpl,
    });
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
      now, submitRequest: (input) => metadata.run(() => submitRequest(input)),
      readRequest: (id) => requests.getRequest(id),
      listRequests: (input) => requests.listRequests(input),
      searchTitles: ({ query, page }) => metadata.run(() => searchAniDbTitles({
        baseUrl: shokoBaseUrl, apiKey: shokoApiKey, query, page, fetchImpl,
      })),
      titleRegistry, loadDetail: (input) => metadata.run(() => loadDetail(input)),
      hydrateTitle: (input) => metadata.run(() => hydrator.load(input)),
      observePublicTarget: (target) => plexObserver ?
        metadata.run(() => plexObserver.observeTarget(target)) :
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
        const result = await metadata.run(() => readShokoOneFile({
          baseUrl: shokoBaseUrl, apiKey: shokoApiKey, fileId, fetchImpl,
        }));
        if (result?.state !== 'file') return { state: 'held', reason: 'file_unavailable' };
        return inventory.recordFileObservation({ item: result.item, observedMs: now() });
      })());
    };
    const eventConsumer = createShokoEventConsumer({ refreshFile: refreshShokoFile });
    return { app,
      pollAiringNextPage: () => {
        if (stopping) return Promise.resolve({ state: 'held', reason: 'service_stopping' });
        return track(airingWorker.runOnce());
      },
      tickShokoInventory: () => {
        if (stopping) return Promise.resolve({ state: 'held', reason: 'service_stopping' });
        return track(inventoryWorker.tick());
      },
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
        return track(metadata.run(() => plexObserver.observeTarget(target)));
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
              inventory.close(); hydration.close(); requests.close(); accounts.close();
            }
          })();
        }
        return stopPromise;
      } };
  } catch (error) {
    plexObserver?.close(); inventory?.close(); hydration?.close();
    requests?.close(); accounts?.close();
    throw error;
  }
}
