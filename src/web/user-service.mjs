import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { openAccountLedger } from '../auth/account-ledger.mjs';
import { openRequestLedger } from '../requests/request-ledger.mjs';
import { openRequestProgress } from '../requests/request-progress.mjs';
import { openAcquisitionLedger } from '../acquisition/acquisition-ledger.mjs';
import { openHandoffLedger } from '../acquisition/handoff-ledger.mjs';
import { openHandoffPublishQueue } from '../acquisition/handoff-publish-queue.mjs';
import { openStartQueue } from '../acquisition/start-queue.mjs';
import { openCompletionQueue } from '../acquisition/completion-queue.mjs';
import { listOperationalReview } from '../acquisition/operational-review.mjs';
import { createHeldRequestSubmitter } from '../requests/submit-held-request.mjs';
import { openHydrationLedger } from '../catalogue/hydration-ledger.mjs';
import { createObservedTitleRegistry } from '../catalogue/observed-title-registry.mjs';
import { createCatalogueHydrator } from '../catalogue/catalogue-hydrator.mjs';
import { createAniDbTitleSource } from '../catalogue/anidb-title-source.mjs';
import { createAniDbWeeklySchedule } from '../catalogue/anidb-weekly-schedule.mjs';
import { createSeasonalCatalogue } from '../catalogue/seasonal-catalogue.mjs';
import { createAniDbDisplayReader } from '../catalogue/anidb-display-reader.mjs';
import { createKnownTitleResolver } from '../catalogue/known-title-resolver.mjs';
import { searchAniDbTitles } from '../catalogue/shoko-search.mjs';
import { createShokoPosterReader } from '../catalogue/shoko-poster-reader.mjs';
import { createPosterReader } from '../catalogue/poster-reader.mjs';
import { readAniDbRelatedTitles } from '../catalogue/shoko-related-titles.mjs';
import { readAniDbRelatedTitles as readArchiveRelatedTitles } from
  '../catalogue/anidb-related-titles.mjs';
import { loadAniDbDetail } from '../catalogue/shoko-detail.mjs';
import { requestAniDbHydration } from '../catalogue/shoko-hydration.mjs';
import { collectAniDbDetail } from '../catalogue/collect-detail.mjs';
import { pollAiringWatches } from '../requests/airing-watch-poll.mjs';
import { createAiringPageWorker } from '../requests/airing-page-worker.mjs';
import { buildUserApp } from './user-app.mjs';
import { createMetadataLimiter } from './metadata-limiter.mjs';
import { readShokoFilePage } from '../availability/shoko-file-page.mjs';
import { readShokoOneFile } from '../availability/shoko-one-file.mjs';
import { readShokoRecentPage } from '../availability/shoko-recent-catchup.mjs';
import { openShokoRecentLedger } from '../availability/shoko-recent-ledger.mjs';
import { createShokoRecentWorker } from '../availability/shoko-recent-worker.mjs';
import { createShokoEventConsumer } from '../availability/shoko-event-consumer.mjs';
import { createShokoInventoryWorker, openShokoInventoryLedger } from
  '../availability/shoko-inventory-worker.mjs';
import { createShokoFullReconciliation } from
  '../availability/shoko-full-reconciliation.mjs';
import { createPlexAvailabilityService } from
  '../availability/plex-availability-service.mjs';
import { readShokoFileCandidate } from '../availability/shoko-file-candidate.mjs';
import { openDirectAvailabilityQueue, createDirectAvailabilityWorker,
  createFileAvailabilityWorker } from
  '../availability/direct-availability-queue.mjs';
import { openTitleCheckLedger } from '../availability/title-check-ledger.mjs';
import { createTitleCheckWorker } from '../availability/title-check-worker.mjs';
import { recentPublicCoverage } from '../availability/recent-public-coverage.mjs';
import { openFileBackfillCursor } from
  '../availability/file-backfill-cursor.mjs';
import { openFileProofLedger } from '../availability/file-proof-ledger.mjs';
import { episodeDisplayAvailability } from
  '../availability/episode-display-availability.mjs';
import { createFileBackfillWorker } from '../availability/file-backfill-worker.mjs';
import { createRequestCandidateDiscovery } from
  '../acquisition/request-candidate-discovery.mjs';
import { searchReleaseCandidates } from '../acquisition/prowlarr-search.mjs';
import { previewRequestCandidate } from '../acquisition/request-candidate-preflight.mjs';
import { prepareStoppedCandidate } from '../acquisition/prepare-stopped-candidate.mjs';
import { probeTargetPresence } from '../acquisition/probe-target-presence.mjs';
import { collectFirstTimeUncertain } from
  '../acquisition/collect-first-time-uncertain.mjs';
import { openAcquisitionRuntime } from '../acquisition/acquisition-runtime.mjs';
import { readShokoEpisodeFiles } from '../availability/shoko-episode-files.mjs';
import { readShokoImportActivity } from '../availability/shoko-import-activity.mjs';
import { combineImportActivity } from '../availability/combined-import-activity.mjs';
import { importFeedState, scopedImportFeedState,
  observeImportQuietWindow } from
  '../acquisition/import-quiet-window.mjs';

const withinRoot = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

// Account-backed catalogue and held requests. No acquisition dispatch or
// public Plex availability is connected until their installed gates pass.
export async function createUserService({ dbPath, shokoBaseUrl, shokoApiKey,
  dataDir = null,
  shokoImportRoot = null, shokoImportFolderId = null,
  acquisitionImportParent = null, acquisitionImportFolderId = null,
  qbitSidecarObserver = null,
  sessionKey, publicOrigin, secureCookies = true, shokoHydration = false,
  titleCheck = false, fileBackfill = false, fileProofLifetimeMs = null,
  fileBackfillFilesPerTick = 1,
  shokoRecent = false, shokoInventoryHints = false, anidbTitleDump = false,
  plex = null, prowlarr = null, fetchImpl = fetch,
  onShokoReconciliationNeeded,
  readShokoConnectionState = () => ({ state: 'disconnected' }),
  waitForImportQuiet = (ms, signal) => sleep(ms, undefined, { signal }),
  importFenceTrace,
  now = Date.now, today = () => new Date().toISOString().slice(0, 10) } = {}) {
  if (typeof dbPath !== 'string' || !dbPath ||
      typeof shokoBaseUrl !== 'string' || !shokoBaseUrl ||
      typeof shokoApiKey !== 'string' || !shokoApiKey ||
      (dataDir !== null && (typeof dataDir !== 'string' ||
        !path.isAbsolute(dataDir) || path.normalize(dataDir) !== dataDir)) ||
      typeof fetchImpl !== 'function' || typeof now !== 'function' ||
      typeof today !== 'function' || typeof shokoHydration !== 'boolean' ||
      typeof titleCheck !== 'boolean' || (titleCheck && !plex) ||
      typeof fileBackfill !== 'boolean' ||
      !Number.isSafeInteger(fileBackfillFilesPerTick) ||
      fileBackfillFilesPerTick < 1 || fileBackfillFilesPerTick > 10 ||
      (fileBackfill && (!plex || !shokoInventoryHints ||
        !Number.isSafeInteger(fileProofLifetimeMs) ||
        fileProofLifetimeMs < 30 * 60_000 ||
        fileProofLifetimeMs > 7 * 24 * 60 * 60_000)) ||
      (shokoImportRoot !== null &&
        (typeof shokoImportRoot !== 'string' ||
         !path.isAbsolute(shokoImportRoot) ||
         path.parse(shokoImportRoot).root === shokoImportRoot ||
         path.normalize(shokoImportRoot) !== shokoImportRoot ||
         /[\0\r\n]/.test(shokoImportRoot))) ||
      (shokoImportFolderId !== null &&
        (!Number.isSafeInteger(shokoImportFolderId) ||
         shokoImportFolderId < 1 || shokoImportRoot === null)) ||
      ((acquisitionImportParent === null) !==
        (acquisitionImportFolderId === null)) ||
      (acquisitionImportParent !== null &&
        (typeof acquisitionImportParent !== 'string' ||
         !path.isAbsolute(acquisitionImportParent) ||
         path.parse(acquisitionImportParent).root === acquisitionImportParent ||
         path.normalize(acquisitionImportParent) !== acquisitionImportParent ||
         /[\0\r\n]/.test(acquisitionImportParent) ||
         !Number.isSafeInteger(acquisitionImportFolderId) ||
         acquisitionImportFolderId < 1 ||
         acquisitionImportFolderId === shokoImportFolderId ||
         shokoImportRoot === null ||
         withinRoot(shokoImportRoot, acquisitionImportParent) ||
         withinRoot(acquisitionImportParent, shokoImportRoot))) ||
      (qbitSidecarObserver !== null &&
        (shokoImportFolderId === null ||
         typeof qbitSidecarObserver.readTorrent !== 'function' ||
         typeof qbitSidecarObserver.importSavePath !== 'string' ||
         !qbitSidecarObserver.importSavePath.startsWith('/'))) ||
      typeof shokoRecent !== 'boolean' ||
      typeof shokoInventoryHints !== 'boolean' ||
      typeof anidbTitleDump !== 'boolean' ||
      (onShokoReconciliationNeeded !== undefined &&
        typeof onShokoReconciliationNeeded !== 'function') ||
      typeof readShokoConnectionState !== 'function' ||
      typeof waitForImportQuiet !== 'function' ||
      (importFenceTrace !== undefined &&
        typeof importFenceTrace !== 'function') ||
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
  let publishReview;
  let startReview;
  let completionReview;
  let progress;
  let hydration;
  let inventory;
  let recent;
  let directAvailability;
  let titleChecks;
  let plexObserver;
  let fileCursor;
  let fileProofs;
  try {
    accounts = openAccountLedger(dbPath, { now });
    requests = openRequestLedger(dbPath);
    acquisitions = openAcquisitionLedger(dbPath);
    handoffs = openHandoffLedger(dbPath);
    publishReview = openHandoffPublishQueue(dbPath);
    startReview = openStartQueue(dbPath);
    completionReview = openCompletionQueue(dbPath);
    progress = openRequestProgress(dbPath);
    hydration = openHydrationLedger(dbPath);
    inventory = openShokoInventoryLedger(dbPath);
    if (shokoRecent) recent = openShokoRecentLedger(dbPath);
    directAvailability = openDirectAvailabilityQueue(dbPath);
    if (titleCheck) titleChecks = openTitleCheckLedger(dbPath);
    const metadata = createMetadataLimiter();
    const cataloguePosters = createPosterReader({ fetchImpl, now });
    const shokoPosters = createShokoPosterReader({ baseUrl: shokoBaseUrl,
      apiKey: shokoApiKey, fetchImpl, now });
    const displayReader = createAniDbDisplayReader({ fetchImpl, now });
    const weeklySchedule = createAniDbWeeklySchedule({ fetchImpl, now });
    const seasonalCatalogue = createSeasonalCatalogue({ fetchImpl, now });
    const titleSource = anidbTitleDump ? createAniDbTitleSource({ fetchImpl, now,
      ...(dataDir === null ? {} : {
        cachePath: path.join(dataDir, 'anime-titles.dat.gz') }) }) : null;
    if (plex) plexObserver = createPlexAvailabilityService({ dbPath,
      shokoBaseUrl, shokoApiKey, ...plex, fetchImpl, now });
    if (fileBackfill) {
      // Resume the saved sweep and bounded proofs after restart. Accepted
      // Shoko/Plex changes withdraw only the affected exact proof rows.
      fileCursor = openFileBackfillCursor(dbPath);
      fileProofs = openFileProofLedger(dbPath, {
        positiveLifetimeMs: fileProofLifetimeMs, now });
    }
    const enqueueChangedFile = ({ before, after, observedMs,
      priority = 'reconcile' }) => {
      if (priority === 'event' && after?.state === 'linked' &&
          after.pairs?.length) {
        fileCursor?.prioritizeFile({ fileId: after.fileId, observedMs });
      }
      const pairs = new Map();
      for (const pair of [...(before?.pairs ?? []), ...(after?.pairs ?? [])]) {
        pairs.set(`${pair.anidbId}:${pair.episodeId}`, pair);
      }
      for (const pair of pairs.values()) {
        const previous = directAvailability.getObservation(pair);
        directAvailability.enqueue({ ...pair,
          observedMs: Math.max(observedMs, (previous?.observedMs ?? -1) + 1),
          priority });
        try { titleChecks?.invalidateTarget({ ...pair, observedMs }); }
        catch { /* Direct import reconciliation must still proceed. */ }
      }
    };
    const inventoryWorker = createShokoInventoryWorker({ ledger: inventory, now,
      onChangedFile: enqueueChangedFile,
      readPage: (input) => metadata.run(() => readShokoFilePage({
        baseUrl: shokoBaseUrl, apiKey: shokoApiKey, ...input,
        includeHints: shokoInventoryHints, fetchImpl,
      })) });
    const titleRegistry = createObservedTitleRegistry({ now });
    const confirmKnownTitle = createKnownTitleResolver({
      registry: titleRegistry, source: titleSource });
    const loadDetail = ({ anidbId, page }) => loadAniDbDetail({
      baseUrl: shokoBaseUrl, apiKey: shokoApiKey, anidbId, page, fetchImpl,
    });
    const observeCurrentPublic = (target, observedShoko,
      includeProof = false) => {
      if (directAvailability.getObservation(target) &&
          inventory.getObservedFileIds(target).length === 0) {
        return Promise.resolve({ state: 'unknown', reason: 'shoko_identity_changed' });
      }
      return metadata.run(() => plexObserver.observeTarget(target,
        observedShoko, { includeProof }));
    };
    const observeDisplayPublic = async (target) => {
      const live = await observeCurrentPublic(target);
      if (live?.state === 'available') return live;
      const saved = target.kind === 'series' &&
        inventory.getObservedFileIds(target).length > 0
        ? fileProofs?.getCurrent(target) : null;
      return saved?.state === 'available' &&
        saved.presentation === 'alternate_card'
        ? { state: 'available', presentation: 'alternate_card' } : live;
    };
    const directWorker = createDirectAvailabilityWorker({ queue: directAvailability,
      now, requireProof: true,
      onRecordedAvailable: (proof) => fileCursor?.confirmRecentFile({
        fileId: proof.fileId, nowMs: now() }),
      observeTarget: async (target) => {
        if (!plexObserver) return { state: 'unknown' };
        if (inventory.getObservedFileIds(target).length === 0) {
          return { state: 'unknown' };
        }
        const detail = await metadata.run(() => loadDetail({
          anidbId: target.anidbId, page: 1 }));
        if (detail?.state === 'busy') return detail;
        if (detail?.state !== 'details') return { state: 'unknown' };
        return observeCurrentPublic({ ...target, kind: detail.kind },
          undefined, true);
      } });
    const fileWorker = createFileAvailabilityWorker({
      queue: directAvailability, inventory, now,
      onRecordedAvailable: (proof) => fileCursor?.confirmRecentFile({
        fileId: proof.fileId, nowMs: now() }),
      readCandidate: ({ fileId }) => metadata.run(() =>
        readShokoFileCandidate({ baseUrl: shokoBaseUrl,
          apiKey: shokoApiKey, fileId, fetchImpl })),
      resolveKind: async ({ anidbId }) => {
        const detail = await metadata.run(() => loadDetail({ anidbId, page: 1 }));
        if (detail?.state === 'busy') return detail;
        return detail?.state === 'details' ? detail.kind : null;
      },
      observeCandidate: (input) => metadata.run(() =>
        plexObserver.observeFileCandidate(input)),
      observeFallback: async (target) => {
        const detail = await metadata.run(() => loadDetail({
          anidbId: target.anidbId, page: 1 }));
        if (detail?.state === 'busy') return detail;
        return detail?.state === 'details' ? observeCurrentPublic({
          ...target, kind: detail.kind }, undefined, true) : { state: 'unknown' };
      },
    });
    const backfillWorker = fileBackfill ? createFileBackfillWorker({
      cursor: fileCursor, inventory, proofs: fileProofs, now,
      maxFilesPerTick: fileBackfillFilesPerTick,
      readCandidate: ({ fileId }) => metadata.run(() =>
        readShokoFileCandidate({ baseUrl: shokoBaseUrl,
          apiKey: shokoApiKey, fileId, fetchImpl })),
      resolveKind: async ({ anidbId }) => {
        const detail = await metadata.run(() => loadDetail({ anidbId, page: 1 }));
        if (['busy', 'unavailable'].includes(detail?.state)) return detail;
        return detail?.state === 'details' ? detail.kind : null;
      },
      observeCandidate: (input) => metadata.run(() =>
        plexObserver.observeFileCandidate(input)),
    }) : null;
    const titleWorker = titleChecks ? createTitleCheckWorker({
      ledger: titleChecks, now,
      loadDetail: (input) => metadata.run(() => loadDetail(input)),
      observeTarget: (target) => observeCurrentPublic(target),
    }) : null;
    const hydrator = createCatalogueHydrator({
      isKnownTitle: confirmKnownTitle,
      loadDetail, ledger: hydration, now,
      requestHydration: ({ anidbId }) => requestAniDbHydration({
        baseUrl: shokoBaseUrl, apiKey: shokoApiKey, anidbId, fetchImpl,
      }),
    });
    const submitRequest = createHeldRequestSubmitter({
      titleRegistry, confirmKnownTitle, loadDetail, ledger: requests, now, today,
    });
    const releaseQueries = async ({ anidbId }) => {
        const status = await titleSource?.refresh();
        return status?.state === 'ready' || status?.state === 'stale'
          ? titleSource.releaseQueries(anidbId) : [];
      };
    const discoverCandidates = prowlarr ? createRequestCandidateDiscovery({
      readRequest: (id) => requests.getRequest(id),
      loadDetail: (input) => metadata.run(() => loadDetail(input)),
      releaseQueries,
      searchReleases: ({ query }) => metadata.run(() => searchReleaseCandidates({
        baseUrl: prowlarr.baseUrl, apiKey: prowlarr.apiKey,
        indexerIds: prowlarr.indexerIds, query, fetchImpl })),
    }) : undefined;
    const previewCandidate = prowlarr ? ({ requestId, candidate }) =>
      previewRequestCandidate({ requestId, candidate,
        readRequest: (id) => requests.getRequest(id),
        loadDetail: (input) => metadata.run(() => loadDetail(input)),
        readRelatedTitles: ({ anidbId }) => metadata.run(() =>
          readAniDbRelatedTitles({ baseUrl: shokoBaseUrl,
            apiKey: shokoApiKey, anidbId, fetchImpl })),
        releaseQueries,
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
    const readImportActivity = shokoImportRoot !== null &&
      shokoImportFolderId !== null ? async (withFingerprint = false, target = null) => {
        const manual = await metadata.run(() => readShokoImportActivity({
          baseUrl: shokoBaseUrl,
          apiKey: shokoApiKey, fetchImpl, importRoot: shokoImportRoot,
          managedFolderId: shokoImportFolderId, withFingerprint,
          ...(qbitSidecarObserver === null ? {} : {
            readSidecarTorrent: qbitSidecarObserver.readTorrent,
            qbitImportSavePath: qbitSidecarObserver.importSavePath }) }));
        if (acquisitionImportParent === null) return manual;
        const automated = await metadata.run(() => readShokoImportActivity({
          baseUrl: shokoBaseUrl, apiKey: shokoApiKey, fetchImpl,
          importRoot: acquisitionImportParent,
          managedFolderId: acquisitionImportFolderId, withFingerprint,
          ...(target === null ? {} : { target,
            ownedSubtree: 'Negev',
            getHandoff: (attemptId) => handoffs.getHandoff(attemptId) }),
        }));
        return combineImportActivity(manual, automated, withFingerprint);
      } : null;
    let acquisitionRuntime;
    const publicPresenceForTitle = (anidbId, checkedMs) => {
      const ids = plexObserver ? new Set([
        ...directAvailability.getRecentAvailableIds({ anidbId, nowMs: checkedMs }),
        ...(titleChecks?.getRecentAvailableIds({ anidbId, nowMs: checkedMs }) ?? []),
        ...(fileProofs?.getRecentAvailableIds({ anidbId }) ?? []),
      ]) : new Set();
      return { state: ids.size > 0 ? 'in_library' : 'unknown',
        verifiedEpisodeCount: ids.size };
    };
    const app = await buildUserApp({ accounts, sessionKey, publicOrigin, secureCookies,
      readImportActivity,
      getAcquisitionStatus: () => acquisitionRuntime?.getStatus() ??
        { state: 'disabled' },
      publicAvailabilityConfigured: Boolean(plexObserver),
      now, submitRequest: (input) => metadata.run(() => submitRequest(input)),
      readRequest: (id) => requests.getRequest(id),
      listRequests: (input) => {
        const page = requests.listRequests(input);
        const checkedMs = now();
        const positivesByTitle = new Map();
        return { ...page, items: page.items.map((item) => {
          const local = progress.read(item.id);
          let coverage = null;
          if (plexObserver) {
            if (!positivesByTitle.has(item.anidbId)) {
              positivesByTitle.set(item.anidbId, {
                directIds: directAvailability.getRecentAvailableIds({
                  anidbId: item.anidbId, nowMs: checkedMs }),
                titleIds: titleChecks?.getRecentAvailableIds({
                  anidbId: item.anidbId, nowMs: checkedMs }) ?? [],
                fileIds: fileProofs?.getRecentAvailableIds({
                  anidbId: item.anidbId }) ?? [],
              });
            }
            coverage = recentPublicCoverage({ episodeIds: item.episodeIds,
              ...positivesByTitle.get(item.anidbId) });
          }
          return { ...item, progress: coverage?.verifiedTargets > 0
            ? { ...local, publicAvailability: 'verified_recently',
              publicVerifiedTargets: coverage.verifiedTargets }
            : local };
        }) };
      },
      searchTitles: async ({ query, page }) => {
        const withPublicPresence = (result) => {
          if (result?.state !== 'results' || !Array.isArray(result.items)) {
            return result;
          }
          const checkedMs = now();
          return { ...result, items: result.items.map((item) => {
            return { ...item, libraryPresence:
              publicPresenceForTitle(item.anidbId, checkedMs) };
          }) };
        };
        const sourceStatus = await titleSource?.refresh();
        if (sourceStatus?.state === 'ready' || sourceStatus?.state === 'stale') {
          const result = titleSource.search({ query, page });
          return sourceStatus.state === 'stale'
            ? withPublicPresence({ ...result, catalogueSource: 'anidb_dump',
              catalogueStale: true,
              ...(sourceStatus.cacheWriteFailed ? { catalogueCacheWriteFailed: true } : {}) })
            : withPublicPresence({ ...result, catalogueSource: 'anidb_dump',
              ...(sourceStatus.cacheWriteFailed ? { catalogueCacheWriteFailed: true } : {}) });
        }
        const result = await metadata.run(() => searchAniDbTitles({
          baseUrl: shokoBaseUrl, apiKey: shokoApiKey, query, page, fetchImpl,
        }));
        return withPublicPresence({ ...result, catalogueSource: 'shoko_cache' });
      },
      listLibraryTitles: plexObserver && fileProofs ?
        async ({ afterAnidbId, limit }) => {
          const source = await titleSource?.refresh();
          if (titleSource && !['ready', 'stale'].includes(source?.state)) {
            return { state: 'unavailable' };
          }
          const page = fileProofs.listCurrentTitles({ afterAnidbId, limit });
          return { state: 'current_proofs',
            items: page.items.map((item) => ({ ...item,
              title: titleSource?.getTitle(item.anidbId) ??
                `Anime title unavailable (${item.anidbId})` })),
            nextAfterAnidbId: page.nextAfterAnidbId };
        } : undefined,
      listAiringSchedule: () => weeklySchedule.read(),
      listSeasonalTitles: async (input) => {
        const page = await seasonalCatalogue.read(input);
        if (!Array.isArray(page.items)) return page;
        const checkedMs = now();
        return { ...page, items: page.items.map((item) => ({ ...item,
          libraryPresence: publicPresenceForTitle(item.anidbId, checkedMs) })) };
      },
      readPoster: ({ uid }) => shokoPosters.read({ uid }),
      readCataloguePoster: ({ anidbId }) => cataloguePosters.read({ anidbId }),
      readDisplayMetadata: ({ anidbId }) => displayReader.read({ anidbId }),
      loadRelatedTitles: async ({ anidbId }) => {
        const local = await metadata.run(() => readAniDbRelatedTitles({
          baseUrl: shokoBaseUrl, apiKey: shokoApiKey, anidbId, fetchImpl,
        }));
        if (local?.state === 'related_titles' && local.items.length > 0) return local;
        if (local?.state === 'held' || local?.state === 'busy') return local;
        const archive = await readArchiveRelatedTitles({ anidbId, fetchImpl,
          titleForId: (id) => titleSource?.getTitle(id) ?? null });
        return archive.state === 'related_titles' ? archive : local;
      },
      titleRegistry, confirmKnownTitle, loadDetail: async (input) => {
        const detail = await metadata.run(() => loadDetail(input));
        if (!plexObserver || detail?.state !== 'details' ||
            !Array.isArray(detail.episodes) || detail.episodes.length > 100) return detail;
        return { ...detail, episodes: detail.episodes.map((episode) => {
          const target = { anidbId: detail.anidbId,
            episodeId: episode.id, nowMs: now() };
          const directStatus = directAvailability.getStatus(target);
          const title = titleChecks?.getTargetStatus(target).state;
          const file = fileProofs?.getCurrent(target);
          return { ...episode, ...episodeDisplayAvailability({
            direct: directStatus.state,
            directPresentation: directStatus.presentation,
            title, file }) };
        }) };
      },
      startTitleCheck: titleChecks ? ({ anidbId }) =>
        titleChecks.start({ anidbId, nowMs: now() }) : undefined,
      getTitleCheck: titleChecks ? ({ anidbId }) =>
        titleChecks.getProgress({ anidbId, nowMs: now() }) : undefined,
      discoverCandidates, previewCandidate,
      listOperationalReview: (input) => listOperationalReview({
        acquisitions, publishQueue: publishReview,
        startQueue: startReview, completionQueue: completionReview,
        ...input }),
      probeRequestTargets: plexObserver ? ({ request, episodeIds }) =>
        probeTargetPresence({ anidbId: request.anidbId,
          kind: request.kind, episodeIds, now,
          readImportActivity: readImportActivity ?? (() => metadata.run(() =>
            readShokoImportActivity({ baseUrl: shokoBaseUrl,
              apiKey: shokoApiKey, fetchImpl,
              ...(shokoImportRoot === null ? {} :
                { importRoot: shokoImportRoot }) }))),
          readShokoEpisode: (target) => metadata.run(() =>
            readShokoEpisodeFiles({ baseUrl: shokoBaseUrl,
              apiKey: shokoApiKey, ...target, fetchImpl })),
          readPublicTarget: (target, observedShoko) =>
            observeCurrentPublic(target, observedShoko),
        }) : undefined,
      hydrateTitle: shokoHydration ?
        (input) => metadata.run(() => hydrator.load(input)) : undefined,
      observePublicTarget: (target) => plexObserver ?
        observeDisplayPublic(target) :
        { state: 'unknown', reason: 'observer_not_configured' },
    });
    const observations = new Set();
    let stopping = false;
    let stopPromise;
    const quietAbort = new AbortController();
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
        const startingRevision = inventory.getFile(fileId)?.observedMs;
        const startingGeneration = startingRevision === undefined ?
          eventConsumer?.getState().generation : null;
        const result = await metadata.run(() => readShokoOneFile({
          baseUrl: shokoBaseUrl, apiKey: shokoApiKey, fileId, fetchImpl,
        }));
        if (inventory.getFile(fileId)?.observedMs !== startingRevision ||
            (startingRevision === undefined &&
              eventConsumer?.getState().generation !== startingGeneration)) {
          return { state: 'held', reason: 'file_event_during_read' };
        }
        if (result?.state !== 'file') return { state: 'held', reason: 'file_unavailable' };
        const observedMs = Math.max(now(), (startingRevision ?? -1) + 1);
        const saved = inventory.recordFileObservation({ item: result.item, observedMs });
        if (saved.state !== 'recorded_file') return saved;
        const delivery = inventory.deliverPendingChanges({
          handle: (change) => enqueueChangedFile({ ...change, priority: 'event' }),
        });
        if (delivery.state === 'held') return delivery;
        return saved;
      })());
    };
    let eventConsumer;
    const refreshRecognizedShokoFile = async (fileId) => {
      const token = eventConsumer?.snapshotPendingResolution(fileId);
      const result = await refreshShokoFile(fileId);
      const recognized = result?.state === 'recorded_file' ? { ...result,
        recognition: inventory.getFile(fileId)?.state } : result;
      if (token) eventConsumer.acknowledgeLinkedObservation({
        fileId, token, result: recognized });
      return recognized;
    };
    const recentWorker = recent ? createShokoRecentWorker({ ledger: recent, now,
      readPage: (input) => metadata.run(() => readShokoRecentPage({
        baseUrl: shokoBaseUrl, apiKey: shokoApiKey, ...input, fetchImpl,
      })),
      refreshFile: refreshRecognizedShokoFile,
    }) : null;
    eventConsumer = createShokoEventConsumer({
      refreshFile: refreshRecognizedShokoFile,
      onReconciliationNeeded: onShokoReconciliationNeeded,
      onFileEvent: (fileId) => {
        const before = inventory.getFile(fileId);
        const observedMs = now();
        const result = inventory.invalidateFileEvent({ fileId, observedMs });
        if (result.state !== 'invalidated') throw Error('File event invalidation failed');
        if (before?.pairs.length) enqueueChangedFile({ before, after: null,
          observedMs, priority: 'event' });
      },
      onDeleted: (fileId) => {
        const before = inventory.getFile(fileId);
        const observedMs = now();
        const result = inventory.invalidateFileEvent({ fileId, observedMs });
        if (result.state !== 'invalidated') throw Error('File deletion invalidation failed');
        if (before?.pairs.length) enqueueChangedFile({ before, after: null,
          observedMs, priority: 'event' });
      } });
    const fullReconciliation = createShokoFullReconciliation({ ledger: inventory,
      consumer: eventConsumer, readConnectionState: readShokoConnectionState,
      tickPage: () => inventoryWorker.tick() });
    const readImportFeed = () => importFeedState({
      connection: readShokoConnectionState(),
      event: eventConsumer.getState(),
      arrival: eventConsumer.getArrivalState(),
    });
    const readScopedImportFeed = (allowedPendingKeys) =>
      scopedImportFeedState({ connection: readShokoConnectionState(),
        snapshot: eventConsumer.getPendingSnapshot(), allowedPendingKeys,
        allowUnreconciledFirstAttempt: true });
    const observeFirstTimeUncertain = (input) => {
      if (stopping) return Promise.resolve({ state: 'held',
        reason: 'service_stopping' });
      if (!plexObserver || !readImportActivity) {
        return Promise.resolve({ state: 'held',
          reason: 'first_time_observer_unconfigured' });
      }
      const publicLibraryIds = input?.kind === 'movie'
        ? [...plex.publicSections.episode, ...plex.publicSections.movie]
        : [...plex.publicSections.episode];
      return track(collectFirstTimeUncertain({ ...input,
        publicLibraryIds, now,
        readEpisode: (target) => metadata.run(() =>
          readShokoEpisodeFiles({ baseUrl: shokoBaseUrl,
            apiKey: shokoApiKey, ...target, purpose: 'first_time', fetchImpl })),
        probePublic: (target) => metadata.run(() =>
          plexObserver.probeFirstTimeSections(target)),
        observeImport: (target) => observeImportQuietWindow({ ...target,
          readActivity: (scope) => readImportActivity(true, scope),
          readFeedState: readImportFeed,
          readScopedFeedState: readScopedImportFeed,
          wait: (ms) => waitForImportQuiet(ms, quietAbort.signal),
          now, requireFingerprint: true, trace: importFenceTrace,
        }),
        readFeedState: readScopedImportFeed,
      }));
    };
    return { app,
      pollAiringNextPage: () => {
        if (stopping) return Promise.resolve({ state: 'held', reason: 'service_stopping' });
        return track(airingWorker.runOnce());
      },
      tickShokoInventory: () => {
        if (stopping) return Promise.resolve({ state: 'held', reason: 'service_stopping' });
        return track(fullReconciliation.tick());
      },
      tickShokoRecentScan: () => {
        if (stopping) return Promise.resolve({ state: 'held', reason: 'service_stopping' });
        if (!recentWorker) return Promise.resolve({ state: 'held',
          reason: 'recent_observer_disabled' });
        const generation = eventConsumer.getState().generation;
        return track((async () => {
          const result = await recentWorker.scan();
          if (result.state === 'caught_up' &&
              recent.getCapacity().pending === 0) {
            eventConsumer.acknowledgeReconciliation(generation);
          }
          return result;
        })());
      },
      tickShokoRecentDrain: () => {
        if (stopping) return Promise.resolve({ state: 'held', reason: 'service_stopping' });
        return recentWorker ? track(recentWorker.drainOne()) :
          Promise.resolve({ state: 'held', reason: 'recent_observer_disabled' });
      },
      tickDirectAvailability: () => {
        if (stopping) return Promise.resolve({ state: 'held', reason: 'service_stopping' });
        if (!plexObserver) return Promise.resolve({ state: 'held',
          reason: 'observer_not_configured' });
        return track(directWorker.runOnce());
      },
      tickFileAvailability: () => {
        if (stopping) return Promise.resolve({ state: 'held',
          reason: 'service_stopping' });
        if (!plexObserver) return Promise.resolve({ state: 'held',
          reason: 'observer_not_configured' });
        return track(fileWorker.runOnce());
      },
      tickFileBackfill: () => {
        if (stopping) return Promise.resolve({ state: 'held',
          reason: 'service_stopping' });
        return backfillWorker ? track(backfillWorker.runOnce()) :
          Promise.resolve({ state: 'held', reason: 'file_backfill_disabled' });
      },
      tickTitleCheck: () => {
        if (stopping) return Promise.resolve({ state: 'held', reason: 'service_stopping' });
        return titleWorker ? track(titleWorker.runOnce()) :
          Promise.resolve({ state: 'held', reason: 'title_check_disabled' });
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
      getShokoArrivalState: () => eventConsumer.getArrivalState(),
      getImportFeedState: readImportFeed,
      observeFirstTimeUncertain,
      openAcquisitionWorkers({ qbBaseUrl, sessionGate, stagingHostPath,
        qbitStagingRoot, holdingRoot, importRoot, inspectMounts,
        verifyStagingRoot, verifyShokoSource, realpathImpl,
        shokoProviderId, readPacer } = {}) {
        if (stopping || acquisitionRuntime) {
          throw new Error('Acquisition workers unavailable');
        }
        // Publication is restricted to Negev's child of its separate watched
        // Shoko Source. Preparing inside that watched root is forbidden.
        if (acquisitionImportParent === null ||
            acquisitionImportFolderId === null ||
            importRoot !== path.join(acquisitionImportParent, 'Negev') ||
            typeof holdingRoot !== 'string' ||
            !path.isAbsolute(holdingRoot) ||
            path.normalize(holdingRoot) !== holdingRoot ||
            path.basename(holdingRoot) !== 'holding' ||
            path.basename(acquisitionImportParent) !== 'source' ||
            path.dirname(holdingRoot) !==
              path.dirname(acquisitionImportParent) ||
            withinRoot(shokoImportRoot, holdingRoot) ||
            withinRoot(acquisitionImportParent, holdingRoot) ||
            withinRoot(holdingRoot, acquisitionImportParent)) {
          throw new TypeError('Dedicated acquisition handoff roots required');
        }
        if (!prowlarr || !plexObserver || !readImportActivity ||
            typeof verifyShokoSource !== 'function' ||
            !Array.isArray(plex?.sourcePolicy) ||
            !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
              .test(shokoProviderId)) {
          throw new TypeError('Acquisition provider evidence unconfigured');
        }
        acquisitionRuntime = openAcquisitionRuntime({ enabled: true,
          dbPath, requests, acquisitions, handoffs, qbBaseUrl, sessionGate,
          stagingHostPath, qbitStagingRoot, holdingRoot, importRoot,
          inspectMounts, verifyStagingRoot, verifyShokoSource,
          realpathImpl, readPacer, fetchImpl, now,
          shoko: { baseUrl: shokoBaseUrl, apiKey: shokoApiKey,
            providerId: shokoProviderId },
          publicSections: plex.publicSections, prowlarr,
          firstTimePolicy: 'single_uncertain_attempt',
          readPublicCoverage: ({ anidbId, episodeIds }) => {
            const checkedMs = now();
            return recentPublicCoverage({ episodeIds, includeIds: true,
              directIds: directAvailability.getRecentAvailableIds({
                anidbId, nowMs: checkedMs }),
              titleIds: titleChecks?.getRecentAvailableIds({
                anidbId, nowMs: checkedMs }) ?? [],
              fileIds: fileProofs?.getRecentAvailableIds({ anidbId }) ?? [],
            });
          },
          discoverCandidates, previewCandidate, releaseQueries,
          loadDetail: ({ anidbId }) => collectAniDbDetail({ anidbId,
            loadPage: async ({ page }) => {
              if (page > 1) await sleep(250);
              return metadata.run(() => loadDetail({ anidbId, page }));
            } }),
          readEvidence: observeFirstTimeUncertain,
        });
        return acquisitionRuntime;
      },
      getObservedShokoFileIds: (input) => inventory.getObservedFileIds(input),
      close() {
        if (!stopPromise) {
          stopping = true;
          quietAbort.abort();
          stopPromise = (async () => {
            try { await app.close(); }
            finally {
              await acquisitionRuntime?.stop();
              await eventConsumer.close();
              await Promise.allSettled([...observations]);
              plexObserver?.close();
              fileProofs?.close(); fileCursor?.close();
              directAvailability.close();
              titleChecks?.close();
              recent?.close();
              inventory.close(); hydration.close(); progress.close();
              completionReview.close(); startReview.close(); publishReview.close();
              handoffs.close(); acquisitions.close();
              requests.close(); accounts.close();
            }
          })();
        }
        return stopPromise;
      } };
  } catch (error) {
    plexObserver?.close(); fileProofs?.close(); fileCursor?.close();
    directAvailability?.close(); titleChecks?.close(); recent?.close();
    inventory?.close(); hydration?.close();
    progress?.close(); completionReview?.close(); startReview?.close();
    publishReview?.close();
    handoffs?.close(); acquisitions?.close();
    requests?.close(); accounts?.close();
    throw error;
  }
}
