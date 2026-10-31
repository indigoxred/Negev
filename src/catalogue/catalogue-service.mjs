import { buildTestApp } from '../web/app.mjs';
import { createCatalogueHydrator } from './catalogue-hydrator.mjs';
import { openHydrationLedger } from './hydration-ledger.mjs';
import { createObservedTitleRegistry } from './observed-title-registry.mjs';
import { loadAniDbDetail } from './shoko-detail.mjs';
import { collectAniDbDetail } from './collect-detail.mjs';
import { requestAniDbHydration } from './shoko-hydration.mjs';
import { searchAniDbTitles } from './shoko-search.mjs';
import { openRequestLedger } from '../requests/request-ledger.mjs';
import { pollAiringWatches } from '../requests/airing-watch-poll.mjs';
import { createAiringPageWorker } from '../requests/airing-page-worker.mjs';
import { createHeldRequestSubmitter } from '../requests/submit-held-request.mjs';
import { searchReleaseCandidates } from '../acquisition/prowlarr-search.mjs';
import { createRequestCandidateDiscovery } from '../acquisition/request-candidate-discovery.mjs';
import { readPlexSectionKeys } from '../availability/plex-section-keys.mjs';

// An injectable private prototype. No listener, account system, download
// client or production configuration is provided here.
export function createCatalogueTestService({
  shokoBaseUrl, shokoApiKey, dbPath, testToken, fetchImpl = fetch, now = Date.now,
  today = () => new Date().toISOString().slice(0, 10),
  prowlarrBaseUrl, prowlarrApiKey, prowlarrIndexerIds,
  plexBaseUrl, plexToken, plexSections,
}) {
  if (typeof shokoBaseUrl !== 'string' || !shokoBaseUrl ||
      typeof shokoApiKey !== 'string' || !shokoApiKey ||
      typeof dbPath !== 'string' || !dbPath ||
      typeof fetchImpl !== 'function' || typeof now !== 'function' || typeof today !== 'function') {
    throw new TypeError('Invalid private catalogue service configuration');
  }
  const plexConfigured = [plexBaseUrl, plexToken, plexSections]
    .some((value) => value !== undefined);
  const configuredPlexIds = plexSections &&
    Array.isArray(plexSections.episode) && Array.isArray(plexSections.movie)
    ? [...plexSections.episode, ...plexSections.movie] : [];
  if (plexConfigured && (typeof plexBaseUrl !== 'string' || !plexBaseUrl ||
      typeof plexToken !== 'string' || !plexToken ||
      !plexSections || !Array.isArray(plexSections.episode) ||
      !Array.isArray(plexSections.movie) ||
      configuredPlexIds.length === 0 || configuredPlexIds.length > 20 ||
      configuredPlexIds.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
      new Set(configuredPlexIds).size !== configuredPlexIds.length)) {
    throw new TypeError('Invalid private Plex discovery configuration');
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
    const listPlexKeys = !plexConfigured ? undefined : ({ kind, libraryId, offset }) => {
      const allowed = kind === 'episode' ? plexSections.episode :
        kind === 'movie' ? plexSections.movie : [];
      if (!allowed.includes(libraryId)) {
        return { state: 'held', reason: 'section_not_allowed' };
      }
      return readPlexSectionKeys({ baseUrl: plexBaseUrl, token: plexToken,
        libraryId, kind, offset, fetchImpl });
    };
    const app = buildTestApp({
      testToken, titleRegistry,
      searchTitles: ({ query, page }) => searchAniDbTitles({
        baseUrl: shokoBaseUrl, apiKey: shokoApiKey, query, page, fetchImpl,
      }),
      searchReleases,
      listPlexKeys,
      loadDetail,
      hydrateTitle: (input) => hydrator.load(input),
      submitRequest: (input) => submitHeld({ ...input, requesterId: 1 }),
      readRequest,
      discoverCandidates: searchReleases === undefined ? undefined : createRequestCandidateDiscovery({
        readRequest, loadDetail, searchReleases,
      }),
    });
    const pollAiringOnce = ({ afterId = 0, limit = 3 } = {}) => pollAiringWatches({
      ledger: requestLedger, today: today(), afterId, limit,
      loadDetail: ({ anidbId }) => collectAniDbDetail({ anidbId,
        loadPage: async ({ page }) => {
          if (page > 1) await new Promise((resolve) => setTimeout(resolve, 250));
          return loadDetail({ anidbId, page });
        } }),
    });
    const airingPageWorker = createAiringPageWorker({
      ledger: requestLedger, pollPage: pollAiringOnce,
    });
    return {
      app,
      // Explicit private diagnostic invocation only; no route or scheduler.
      pollAiringOnce,
      pollAiringNextPage: () => airingPageWorker.runOnce(),
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
