import { openAccountLedger } from '../auth/account-ledger.mjs';
import { openRequestLedger } from '../requests/request-ledger.mjs';
import { createHeldRequestSubmitter } from '../requests/submit-held-request.mjs';
import { openHydrationLedger } from '../catalogue/hydration-ledger.mjs';
import { createObservedTitleRegistry } from '../catalogue/observed-title-registry.mjs';
import { createCatalogueHydrator } from '../catalogue/catalogue-hydrator.mjs';
import { searchAniDbTitles } from '../catalogue/shoko-search.mjs';
import { loadAniDbDetail } from '../catalogue/shoko-detail.mjs';
import { requestAniDbHydration } from '../catalogue/shoko-hydration.mjs';
import { buildUserApp } from './user-app.mjs';

// Account-backed catalogue and held requests. No acquisition dispatch or
// public Plex availability is connected until their installed gates pass.
export async function createUserService({ dbPath, shokoBaseUrl, shokoApiKey,
  sessionKey, publicOrigin, secureCookies = true, fetchImpl = fetch,
  now = Date.now, today = () => new Date().toISOString().slice(0, 10) } = {}) {
  if (typeof dbPath !== 'string' || !dbPath ||
      typeof shokoBaseUrl !== 'string' || !shokoBaseUrl ||
      typeof shokoApiKey !== 'string' || !shokoApiKey ||
      typeof fetchImpl !== 'function' || typeof now !== 'function' ||
      typeof today !== 'function') throw new TypeError('Invalid user service configuration');
  let accounts;
  let requests;
  let hydration;
  try {
    accounts = openAccountLedger(dbPath, { now });
    requests = openRequestLedger(dbPath);
    hydration = openHydrationLedger(dbPath);
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
    const app = await buildUserApp({ accounts, sessionKey, publicOrigin, secureCookies,
      now, submitRequest, readRequest: (id) => requests.getRequest(id),
      searchTitles: ({ query, page }) => searchAniDbTitles({
        baseUrl: shokoBaseUrl, apiKey: shokoApiKey, query, page, fetchImpl,
      }),
      titleRegistry, loadDetail, hydrateTitle: (input) => hydrator.load(input),
    });
    return { app, async close() {
      try { await app.close(); }
      finally { hydration.close(); requests.close(); accounts.close(); }
    } };
  } catch (error) {
    hydration?.close(); requests?.close(); accounts?.close();
    throw error;
  }
}
