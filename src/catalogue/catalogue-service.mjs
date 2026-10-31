import { buildTestApp } from '../web/app.mjs';
import { createCatalogueHydrator } from './catalogue-hydrator.mjs';
import { openHydrationLedger } from './hydration-ledger.mjs';
import { createObservedTitleRegistry } from './observed-title-registry.mjs';
import { loadAniDbDetail } from './shoko-detail.mjs';
import { requestAniDbHydration } from './shoko-hydration.mjs';
import { searchAniDbTitles } from './shoko-search.mjs';
import { openRequestLedger } from '../requests/request-ledger.mjs';
import { createHeldRequestSubmitter } from '../requests/submit-held-request.mjs';
import { searchReleaseCandidates } from '../acquisition/prowlarr-search.mjs';
import { createRequestCandidateDiscovery } from '../acquisition/request-candidate-discovery.mjs';

// An injectable private prototype. No listener, account system, download
// client or production configuration is provided here.
export function createCatalogueTestService({
  shokoBaseUrl, shokoApiKey, dbPath, testToken, fetchImpl = fetch, now = Date.now,
  today = () => new Date().toISOString().slice(0, 10),
  prowlarrBaseUrl, prowlarrApiKey, prowlarrIndexerIds,
}) {
  if (typeof shokoBaseUrl !== 'string' || !shokoBaseUrl ||
      typeof shokoApiKey !== 'string' || !shokoApiKey ||
      typeof dbPath !== 'string' || !dbPath ||
      typeof fetchImpl !== 'function' || typeof now !== 'function' || typeof today !== 'function') {
    throw new TypeError('Invalid private catalogue service configuration');
  }
  const ledger = openHydrationLedger(dbPath);
  let requestLedger;
  try {
    requestLedger = openRequestLedger(dbPath);
    const titleRegistry = createObservedTitleRegistry({ now });
    const loadDetail = ({ anidbId, page }) => loadAniDbDetail({
      baseUrl: shokoBaseUrl, apiKey: shokoApiKey, anidbId, page, fetchImpl,
    });
    const hydrator = createCatalogueHydrator({
      isKnownTitle: (input) => titleRegistry.isKnownTitle(input),
      loadDetail, ledger, now,
      requestHydration: ({ anidbId }) => requestAniDbHydration({
        baseUrl: shokoBaseUrl, apiKey: shokoApiKey, anidbId, fetchImpl,
      }),
    });
    const submitHeld = createHeldRequestSubmitter({
      titleRegistry, loadDetail, ledger: requestLedger, now, today,
    });
    const readRequest = (id) => {
      const request = requestLedger.getRequest(id);
      return request?.requesterId === 1 ? request : null;
    };
    const searchReleases = prowlarrBaseUrl === undefined ? undefined : ({ query }) => searchReleaseCandidates({
      baseUrl: prowlarrBaseUrl, apiKey: prowlarrApiKey, indexerIds: prowlarrIndexerIds,
      query, fetchImpl,
    });
    const app = buildTestApp({
      testToken, titleRegistry,
      searchTitles: ({ query, page }) => searchAniDbTitles({
        baseUrl: shokoBaseUrl, apiKey: shokoApiKey, query, page, fetchImpl,
      }),
      searchReleases,
      loadDetail,
      hydrateTitle: (input) => hydrator.load(input),
      submitRequest: (input) => submitHeld({ ...input, requesterId: 1 }),
      readRequest,
      discoverCandidates: searchReleases === undefined ? undefined : createRequestCandidateDiscovery({
        readRequest, loadDetail, searchReleases,
      }),
    });
    return {
      app,
      async close() {
        try { await app.close(); }
        finally { requestLedger.close(); ledger.close(); }
      },
    };
  } catch (error) {
    requestLedger?.close();
    ledger.close();
    throw error;
  }
}
