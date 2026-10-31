import { buildTestApp } from '../web/app.mjs';
import { createCatalogueHydrator } from './catalogue-hydrator.mjs';
import { openHydrationLedger } from './hydration-ledger.mjs';
import { createObservedTitleRegistry } from './observed-title-registry.mjs';
import { loadAniDbDetail } from './shoko-detail.mjs';
import { requestAniDbHydration } from './shoko-hydration.mjs';
import { searchAniDbTitles } from './shoko-search.mjs';

// An injectable private prototype. No listener, account system, request
// creation, download client or production configuration is provided here.
export function createCatalogueTestService({
  shokoBaseUrl, shokoApiKey, dbPath, testToken, fetchImpl = fetch, now = Date.now,
}) {
  if (typeof shokoBaseUrl !== 'string' || !shokoBaseUrl ||
      typeof shokoApiKey !== 'string' || !shokoApiKey ||
      typeof dbPath !== 'string' || !dbPath ||
      typeof fetchImpl !== 'function' || typeof now !== 'function') {
    throw new TypeError('Invalid private catalogue service configuration');
  }
  const ledger = openHydrationLedger(dbPath);
  try {
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
    const app = buildTestApp({
      testToken, titleRegistry,
      searchTitles: ({ query, page }) => searchAniDbTitles({
        baseUrl: shokoBaseUrl, apiKey: shokoApiKey, query, page, fetchImpl,
      }),
      loadDetail,
      hydrateTitle: (input) => hydrator.load(input),
    });
    return {
      app,
      async close() {
        try { await app.close(); }
        finally { ledger.close(); }
      },
    };
  } catch (error) {
    ledger.close();
    throw error;
  }
}
