import { createAcquisitionAccess } from '../acquisition/acquisition-access.mjs';
import { queueCompositeObservation } from '../availability/queue-composite-observation.mjs';
import { createWatchingScheduleReader } from './watching-schedule.mjs';
import { createCatalogueFetch } from '../catalogue/catalogue-fetch.mjs';
import { createBonusOwnershipReader } from '../acquisition/bonus-ownership.mjs';
import { cachedRegularCoverage } from './card-coverage.mjs';
import { createReleasePreviews } from '../requests/release-previews.mjs';
import { createReleaseWake, observedReleaseEpisodes } from '../acquisition/release-wake.mjs';
import { createReleaseSelection } from '../acquisition/release-selection.mjs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { openAccountLedger } from '../auth/account-ledger.mjs';
import { openRequestLedger } from '../requests/request-ledger.mjs';
import { openAcquisitionRequestQueue } from '../acquisition/acquisition-request-queue.mjs';
import { openPendingTitleLedger } from '../requests/pending-title-ledger.mjs';
import { createPendingTitleWorker } from '../requests/pending-title-worker.mjs';
import { openRequestProgress } from '../requests/request-progress.mjs';
import { openAcquisitionLedger } from '../acquisition/acquisition-ledger.mjs';
import { openHandoffLedger } from '../acquisition/handoff-ledger.mjs';
import { openPureMoveLedger } from '../acquisition/pure-move-ledger.mjs';
import { openRecognitionRecoveryLedger } from
  '../acquisition/recognition-recovery-ledger.mjs';
import { openShokoRescanLedger } from
  '../acquisition/shoko-rescan-ledger.mjs';
import { openHandoffPublishQueue } from '../acquisition/handoff-publish-queue.mjs';
import { openStartQueue } from '../acquisition/start-queue.mjs';
import { openCompletionQueue } from '../acquisition/completion-queue.mjs';
import { listOperationalReview } from '../acquisition/operational-review.mjs';
import { deleteAccount as deleteAccountData } from '../auth/delete-account.mjs';
import { createHeldRequestSubmitter, requestReleaseState } from '../requests/submit-held-request.mjs';
import { autoTrackSavedAiringRequest } from './auto-track-request.mjs';
import { openHydrationLedger } from '../catalogue/hydration-ledger.mjs';
import { createObservedTitleRegistry } from '../catalogue/observed-title-registry.mjs';
import { createCatalogueHydrator } from '../catalogue/catalogue-hydrator.mjs';
import { createAniDbTitleSource } from '../catalogue/anidb-title-source.mjs';
import { createAniDbWeeklySchedule } from '../catalogue/anidb-weekly-schedule.mjs';
import { createSeasonalCatalogue } from '../catalogue/seasonal-catalogue.mjs';
import { openAniListRankingCache } from '../catalogue/anilist-ranking-cache.mjs';
import { openMappedScoreCache } from '../catalogue/mapped-score-cache.mjs';
import { openSeasonalSnapshot } from '../catalogue/seasonal-snapshot.mjs';
import { createAniDbDisplayReader } from '../catalogue/anidb-display-reader.mjs';
import { createAniMapRawDetailReader } from '../catalogue/animap-raw-detail.mjs';
import { createFastDetailReader } from '../catalogue/fast-detail-reader.mjs';
import { createAniDbMapFactsReader } from '../catalogue/anidb-map-facts.mjs';
import { createAniDbGroupReader } from '../catalogue/anidb-group-reader.mjs';
import { mergeDisplayFacts } from '../catalogue/merge-display-facts.mjs';
import { createKnownTitleResolver } from '../catalogue/known-title-resolver.mjs';
import { searchAniDbTitles } from '../catalogue/shoko-search.mjs';
import { createShokoPosterReader } from '../catalogue/shoko-poster-reader.mjs';
import { createPosterReader } from '../catalogue/poster-reader.mjs';
import { readAniDbRelatedTitles } from '../catalogue/shoko-related-titles.mjs';
import { readAniDbRelatedTitles as readArchiveRelatedTitles,
  createCachedDisplayRelations, readDisplayRelations } from
  '../catalogue/anidb-related-titles.mjs';
import { loadAniDbDetail } from '../catalogue/shoko-detail.mjs';
import { requestAniDbHydration } from '../catalogue/shoko-hydration.mjs';
import { collectAniDbDetail } from '../catalogue/collect-detail.mjs';
import { completeRegularRoster } from '../catalogue/complete-regular-roster.mjs';
import { regularEpisodeSchedule } from './public/episode-schedule.mjs';
import { pollAiringWatches } from '../requests/airing-watch-poll.mjs';
import { createAiringPageWorker } from '../requests/airing-page-worker.mjs';
import { buildUserApp } from './user-app.mjs';
import { createMetadataLimiter } from './metadata-limiter.mjs';
import { readShokoFilePage } from '../availability/shoko-file-page.mjs';
import { readShokoOneFile } from '../availability/shoko-one-file.mjs';
import { currentDisplayAvailability } from '../availability/current-display-availability.mjs';
import { readShokoRecentPage } from '../availability/shoko-recent-catchup.mjs';
import { readShokoFileIdPage } from '../availability/shoko-fileid-catchup.mjs';
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
import { createRecordArrivalProof } from
  '../availability/record-arrival-proof.mjs';
import { countVerifiedRegularEpisodes } from
  '../availability/regular-season-proof.mjs';
import { episodeDisplayAvailability } from
  '../availability/episode-display-availability.mjs';
import { createFileBackfillWorker } from '../availability/file-backfill-worker.mjs';
import { createRequestCandidateDiscovery } from
  '../acquisition/request-candidate-discovery.mjs';
import { searchReleaseCandidates } from '../acquisition/prowlarr-search.mjs';
import { previewRequestCandidate } from '../acquisition/request-candidate-preflight.mjs';
import { createAniDbCorrespondence } from '../identity/anidb-correspondence.mjs';
import { openCandidateCheckCache } from '../acquisition/candidate-check-cache.mjs';
import { readPreviouslyVerifiedFile } from '../identity/previously-verified-file.mjs';
import { readShokoVideoExtensions } from '../acquisition/shoko-video-extensions.mjs';
import { previewOfflineRelease } from '../identity/shoko-offline-preview.mjs';
import { readRelatedEvidence } from '../acquisition/read-related-evidence.mjs';
import { createArchiveRelationReader } from '../acquisition/independent-archive-relations.mjs';
import { prepareStoppedCandidate } from '../acquisition/prepare-stopped-candidate.mjs';
import { probeTargetPresence } from '../acquisition/probe-target-presence.mjs';
import { collectTargetScopedUncertain } from
  '../acquisition/collect-target-scoped-uncertain.mjs';
import { verifyCachedPositiveCoverage } from
  '../acquisition/verify-cached-positive-coverage.mjs';
import { refreshFirstTimeMetadata } from
  '../acquisition/refresh-first-time-metadata.mjs';
import { openAcquisitionRuntime } from '../acquisition/acquisition-runtime.mjs';
import { readShokoEpisodeFiles } from '../availability/shoko-episode-files.mjs';
import { readShokoImportActivity } from '../availability/shoko-import-activity.mjs';
import { combineImportActivity } from '../availability/combined-import-activity.mjs';
import { importFeedState } from
  '../acquisition/import-quiet-window.mjs';
import { runPrestartMismatchRetirement } from
  '../acquisition/run-prestart-mismatch-retirement.mjs';

const withinRoot = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

// Account-backed catalogue and held requests. No acquisition dispatch or
// public Plex availability is connected until their installed gates pass.
export async function createUserService({ dbPath, shokoBaseUrl, shokoApiKey,
  dataDir = null, logger = false,
  shokoImportRoot = null, shokoImportFolderId = null,
  acquisitionImportParent = null, acquisitionImportFolderId = null,
  acquisition = null,
  qbitSidecarObserver = null,
  acquisitionAllowedAnidbIds = null,
  acquisitionOwnershipGate = null,
  sessionKey, publicOrigin, localOrigin = null,
  secureCookies = true, shokoHydration = false,
  titleCheck = false, fileBackfill = false, fileProofLifetimeMs = null,
  fileBackfillFilesPerTick = 1,
  shokoRecent = false, shokoInventoryHints = false, anidbTitleDump = false,
  plex = null, prowlarr = null, fetchImpl = fetch,
  onShokoReconciliationNeeded,
  readShokoConnectionState = () => ({ state: 'disconnected' }),
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
      (fileProofLifetimeMs !== null && (!plex ||
        !Number.isSafeInteger(fileProofLifetimeMs) ||
        fileProofLifetimeMs < 30 * 60_000 ||
        fileProofLifetimeMs > 7 * 24 * 60 * 60_000)) ||
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
  let candidateChecks;
  let pendingTitles;
  let acquisitions;
  let handoffs;
  let pureMoves;
  let recognitionRecoveries;
  let shokoRescans;
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
  let scoreCache;
  let rankings;
  let seasonalSnapshot;
  let fileCursor;
  let fileProofs;
  try {
    accounts = openAccountLedger(dbPath, { now });
    requests = openRequestLedger(dbPath);
    pendingTitles = openPendingTitleLedger(dbPath);
    acquisitions = openAcquisitionLedger(dbPath);
    if (prowlarr) candidateChecks = openCandidateCheckCache(dbPath, { now });
    handoffs = openHandoffLedger(dbPath);
    if (acquisition?.pureMode === true) pureMoves = openPureMoveLedger(dbPath);
    if (pureMoves) recognitionRecoveries = openRecognitionRecoveryLedger(dbPath);
    if (pureMoves) shokoRescans = openShokoRescanLedger(dbPath);
    publishReview = openHandoffPublishQueue(dbPath,
      { pureMode: acquisition?.pureMode === true });
    startReview = openStartQueue(dbPath);
    completionReview = openCompletionQueue(dbPath,
      { pureMode: acquisition?.pureMode === true });
    progress = openRequestProgress(dbPath,
      { pureMode: acquisition?.pureMode === true });
    hydration = openHydrationLedger(dbPath);
    inventory = openShokoInventoryLedger(dbPath);
    if (shokoRecent) recent = openShokoRecentLedger(dbPath);
    directAvailability = openDirectAvailabilityQueue(dbPath, { evidenceTrusted: () => plexObserver?.isScopeCurrent() === true });
    if (titleCheck) titleChecks = openTitleCheckLedger(dbPath, { requireProof: true, evidenceTrusted: () => plexObserver?.isScopeCurrent() === true });
    const metadata = createMetadataLimiter();
    const catalogueFetch = createCatalogueFetch({ fetchImpl, now });
    const cataloguePosters = createPosterReader({ fetchImpl: catalogueFetch, now });
    const shokoPosters = createShokoPosterReader({ baseUrl: shokoBaseUrl,
      apiKey: shokoApiKey, fetchImpl, now });
    const displayReader = createAniDbDisplayReader({ fetchImpl: catalogueFetch, now });
    const mapFacts = createAniDbMapFactsReader({ fetchImpl: catalogueFetch, now });
    const groupRegistry = createAniDbGroupReader({ fetchImpl: catalogueFetch, now });
    const readGroupRegistry = () => groupRegistry.read();
    const rawDetailReader = createAniMapRawDetailReader({ fetchImpl: catalogueFetch, now });
    const weeklySchedule = createAniDbWeeklySchedule({ fetchImpl: catalogueFetch, now });
    scoreCache = openMappedScoreCache({ dbPath, fetchImpl: catalogueFetch, now });
    rankings = openAniListRankingCache({ dbPath, fetchImpl: catalogueFetch, now });
    seasonalSnapshot = openSeasonalSnapshot(dbPath);
    const seasonalCatalogue = createSeasonalCatalogue({ fetchImpl: catalogueFetch, now,
      readSchedule: weeklySchedule.read, scoreCache, rankings,
      snapshotStore: seasonalSnapshot });
    const titleSource = anidbTitleDump ? createAniDbTitleSource({ fetchImpl, now,
      ...(dataDir === null ? {} : {
        cachePath: path.join(dataDir, 'anime-titles.dat.gz') }) }) : null;
    const englishTitleFor = async (anidbId) => {
      const fromDump = titleSource?.getEnglishTitle(anidbId);
      if (fromDump) return fromDump;
      const display = await displayReader.read({ anidbId });
      return display.state === 'display' ? display.englishTitle : null;
    };
    const cachedEnglishTitleFor = (anidbId) => {
      const fromDump = titleSource?.getEnglishTitle(anidbId);
      if (fromDump) return fromDump;
      const display = displayReader.peek({ anidbId });
      if (!display) void displayReader.read({ anidbId }).catch(() => {});
      return display?.state === 'display' ? display.englishTitle : null;
    };
    if (plex) {
      plexObserver = createPlexAvailabilityService({ dbPath,
        shokoBaseUrl, shokoApiKey, ...plex, fetchImpl, now, enforceScope: true });
    }
    if (fileBackfill) {
      // Resume the saved sweep and bounded proofs after restart. Accepted
      // Shoko/Plex changes withdraw only the affected exact proof rows.
      fileCursor = openFileBackfillCursor(dbPath);
    }
    if (plex && fileProofLifetimeMs !== null) {
      fileProofs = openFileProofLedger(dbPath, {
        positiveLifetimeMs: fileProofLifetimeMs, now, evidenceTrusted: () => plexObserver?.isScopeCurrent() === true });
    }
    if (plexObserver) void plexObserver.ensureScope();
    let recentImportUntilMs = 0;
    const acquisitionCoverageCache = new Map();
    const enqueueChangedFile = ({ before, after, observedMs,
      priority = 'reconcile' }) => {
      if (priority === 'event' && after?.state === 'linked' &&
          after.pairs?.length) {
        recentImportUntilMs = Math.max(recentImportUntilMs,
          observedMs + 10 * 60_000);
        fileCursor?.prioritizeFile({ fileId: after.fileId, observedMs });
      }
      const pairs = new Map();
      for (const pair of [...(before?.pairs ?? []), ...(after?.pairs ?? [])]) {
        pairs.set(`${pair.anidbId}:${pair.episodeId}`, pair);
      }
      for (const pair of pairs.values()) {
        candidateChecks?.invalidateTarget(pair);
        acquisitionCoverageCache.delete(`${pair.anidbId}:series:${pair.episodeId}`);
        acquisitionCoverageCache.delete(`${pair.anidbId}:movie:${pair.episodeId}`);
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
    // Cold title pages and the initial save need time for HTTP/auth overhead
    // inside the five-second UI budget. Exact resolution runs later.
    const loadFastDetail = createFastDetailReader({ deadlineMs: 3_000,
      archive: (input) => rawDetailReader.read(input),
      shoko: (input) => metadata.run(() => loadAniDbDetail({
        baseUrl: shokoBaseUrl, apiKey: shokoApiKey,
        ...input, fetchImpl, timeoutMs: 3_000 })),
    });
    const loadCurrentDetail = createFastDetailReader({ prefer: 'shoko',
      archive: (input) => rawDetailReader.read(input),
      shoko: (input) => metadata.run(() => loadDetail(input)),
    });
    const authorizeRequest = createAcquisitionAccess({
      readRequest: id => requests.getRequest(id),
      readAttempt: id => acquisitions.getAttempt(id),
      readUser: userId => accounts.getActiveUser({ userId }),
      readBonuses: attemptId => acquisitions.getBonusPlan(attemptId),
      loadDetail: input => loadCurrentDetail(input),
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
      const live = await observeCurrentPublic(target,undefined,true);
      if (live?.state === 'available') {
        const canonical=fileProofs?.getCurrent(target);
      queueCompositeObservation({queue:directAvailability,target,result:live,nowMs:now(),canonicalAvailable:canonical?.state==='available',canonicalPresentation:canonical?.presentation});
        return live.proof?.presentation==='alternate_card'?{...live,presentation:'alternate_card'}:live;
      }
      const hasShokoFile = target.kind === 'series' &&
        inventory.getObservedFileIds(target).length > 0;
      const file = hasShokoFile ? fileProofs?.getCurrent(target) : null;
      return currentDisplayAvailability({ live, file, hasShokoFile });
    };
    const onRecordedAvailable = fileCursor
      ? createRecordArrivalProof({ inventory, proofs: fileProofs,
        cursor: fileCursor, now }) : () => {};
    const directWorker = createDirectAvailabilityWorker({ queue: directAvailability,
      now, requireProof: true,
      onRecordedAvailable,
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
      onRecordedAvailable,
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
      observeTarget: (target) => observeCurrentPublic(target, undefined, true),
    }) : null;
    const hydrator = createCatalogueHydrator({
      isKnownTitle: confirmKnownTitle,
      loadDetail, ledger: hydration, now,
      requestHydration: ({ anidbId }) => requestAniDbHydration({
        baseUrl: shokoBaseUrl, apiKey: shokoApiKey, anidbId, fetchImpl,
      }),
    });
    const hydrateAndWake = async (input) => {
      const result = await metadata.run(() => hydrator.load(input));
      if (result?.state === 'detail_ready' &&
          result.detail?.anidbId === input.anidbId) {
        candidateChecks?.invalidateTitle(input.anidbId);
        try { acquisitionRuntime?.wakeHydratedTitle(input.anidbId); }
        catch { /* Durable queue retry remains the fallback. */ }
      }
      return result;
    };
    const heldRequestOptions = {
      titleRegistry, confirmKnownTitle, loadDetail: loadFastDetail,
      ledger: requests, now, today,
      authorizeRequester: ({ requesterId }) => {
        const user = accounts.getActiveUser({ userId: requesterId });
        return { active: user !== null,
          adultAllowed: user?.adultAllowed === true };
      },
      recentlyAvailable: ({ anidbId, episodeId }) => {
        const target = { anidbId, episodeId, nowMs: now() };
        return episodeDisplayAvailability({
          direct: directAvailability.getStatus(target).state,
          title: titleChecks?.getTargetStatus(target).state,
          file: fileProofs?.getCurrent(target),
        }).availability === 'available';
      },
    };
    const submitHeldRequest = createHeldRequestSubmitter(heldRequestOptions);
    const prepareRequest = createHeldRequestSubmitter({...heldRequestOptions,
      ledger: {...requests, submit: submission => ({state:'prepared',submission})}});
    let releasePreviews;
    const readSelectionRequest = id => releasePreviews?.readRequest(id) ?? requests.getRequest(id);
    const preparePreview = async input => {
      if(acquisitionAllowedAnidbIds && !acquisitionAllowedAnidbIds.includes(input.anidbId)) return {state:'held',reason:'title_not_in_cutover'};
      if(acquisitionOwnershipGate){
        let ownership;try{ownership=await acquisitionOwnershipGate.refresh();}catch{}
        if(ownership?.state!=='ready')return {state:'held',reason:'sonarr_ownership_unavailable'};
        const status=acquisitionOwnershipGate.status(input.anidbId);
        if(status!=='eligible')return {state:'held',reason:status==='owned'?'title_sonarr_owned':'sonarr_identity_unmapped'};
      }
      await plexObserver?.ensureScope();
      return prepareRequest({...input,releaseMode:'manual'});
    };
    const submitRequest = async (input) => {
      await plexObserver?.ensureScope();
      const result = await submitHeldRequest(input);
      if (result.created === true && Number.isSafeInteger(result.requestId) &&
          result.requestId > 0 && result.targetIds?.length > 0) {
        acquisitionRuntime?.wakeRequest(result.requestId);
      }
      // Pending-title intents resolve here too, outside the HTTP request route.
      autoTrackSavedAiringRequest({ result, requesterId: input.requesterId,
        anidbId: input.anidbId,
        readRequest: (requestId) => requests.getRequest(requestId), accounts });
      return result;
    };
    const pendingTitleWorker = createPendingTitleWorker({
      ledger: pendingTitles, submitRequest, now,
      authorize: ({ requesterId }) =>
        accounts.getActiveUser({ userId: requesterId }) !== null,
      restoreKnownTitle: ({ anidbId, title }) =>
        titleRegistry.observe({ state: 'results', total: 1,
          items: [{ anidbId, title }] }),
      prepareDetail: shokoHydration ? ({ anidbId }) =>
        hydrateAndWake({ anidbId }) : async () => {},
    });
    const releaseQueries = async ({ anidbId }) => {
        const status = await titleSource?.refresh();
        return status?.state === 'ready' || status?.state === 'stale'
          ? titleSource.releaseQueries(anidbId) : [];
      };
    const discoverCandidates = prowlarr ? createRequestCandidateDiscovery({
      now,
      readRequest: readSelectionRequest,
      loadDetail: (input) => loadCurrentDetail(input),
      releaseQueries,
      searchReleases: ({ query, targetEpisodeNumber, limit = 25 }) => searchReleaseCandidates({
        baseUrl: prowlarr.baseUrl, apiKey: prowlarr.apiKey,
        indexerIds: prowlarr.indexerIds,
        trustedIndexerIds: prowlarr.trustedIndexerIds ?? [],
        includeProxyUrl: true, query, targetEpisodeNumber, limit, extended:limit>50, fetchImpl }),
    }) : undefined;
    // Preview, submission, and start must use identical relation evidence.
    // Shoko may not know an unowned season yet, while the AniDB archive does.
    const readArchiveRelations = createArchiveRelationReader({ titleSource,
      fetchImpl, readArchive: readArchiveRelatedTitles });
    const readRelatedTitles = ({ anidbId }) => readRelatedEvidence({ anidbId,
      aliasesForId: (relatedId) => titleSource?.releaseQueries(relatedId) ?? [],
      readLocal: () => metadata.run(() => readAniDbRelatedTitles({
        baseUrl: shokoBaseUrl, apiKey: shokoApiKey, anidbId, fetchImpl })),
      readArchive: () => readArchiveRelations({ anidbId }),
    });
    const inspectCorrespondence = createAniDbCorrespondence({ fetchImpl, now,
      readPreviouslyVerified: async ({ anidbId, torrentHash, file, signal }) => {
        const prior = acquisitions.findPreviouslyVerifiedFile({ anidbId, torrentHash, file });
        if (!prior) return null;
        return readPreviouslyVerifiedFile({ prior, baseUrl: shokoBaseUrl,
          apiKey: shokoApiKey, shokoMount: plex?.shokoMount, fetchImpl, signal });
      },
    });
    const readBonusOwnership=createBonusOwnershipReader({readEpisode:target=>metadata.run(()=>readShokoEpisodeFiles({baseUrl:shokoBaseUrl,apiKey:shokoApiKey,...target,purpose:'first_time',fetchImpl}))});
    const canAcquireRestrictedBonuses=request=>Number.isSafeInteger(request?.requesterId)&&accounts.getActiveUser({userId:request.requesterId})?.adultAllowed===true;
    const previewCandidate = prowlarr ? async ({ requestId, candidate,
      offlineCache, includeFileListing = false }) => {
      const request = readSelectionRequest(requestId);
      const saved = request?.status === 'held' && !request.preview && offlineCache instanceof Map
        ? candidateChecks.get({ request, candidate }) : null;
      if (saved && (!includeFileListing || saved.state === 'preflight')) return { ...saved, cacheHit: true };
      const result = await previewRequestCandidate({ requestId, candidate, includeFileListing,
        offlineCache, inspectCorrespondence,
        readBonusOwnership: acquisition?.pureMode===true?readBonusOwnership:undefined,
        allowRestrictedBonuses: canAcquireRestrictedBonuses(request),
        offlineLookup: ({ filename }) => metadata.run(() => previewOfflineRelease({
          baseUrl: shokoBaseUrl, apiKey: shokoApiKey,
          filename, fetchImpl })),
        readVideoExtensions: () => metadata.run(() => readShokoVideoExtensions({
          baseUrl: shokoBaseUrl, apiKey: shokoApiKey, fetchImpl })),
        readRequest: readSelectionRequest,
        loadDetail: (input) => loadCurrentDetail(input),
        readRelatedTitles,
        releaseQueries,
        prepare: (input) => metadata.run(() => prepareStoppedCandidate({
          baseUrl: prowlarr.baseUrl, apiKey: prowlarr.apiKey,
          indexerIds: prowlarr.indexerIds, ...input, fetchImpl,
        })),
      });
      if (request && !request.preview && !includeFileListing) candidateChecks.put({ request, candidate, result });
      return result;
    } : undefined;
    const readRequestCoverage = async (request) => {
      if(!plexObserver||(await plexObserver.ensureScope()).state!=='ready') throw new Error('Public scope unverified');
      const { anidbId, episodeIds } = request;
      const checkedMs = now();
      const cached = recentPublicCoverage({ episodeIds, includeIds: true,
        directIds: directAvailability.getRecentAvailableIds({anidbId,nowMs:checkedMs}),
        titleIds: titleChecks?.getRecentAvailableIds({anidbId,nowMs:checkedMs})??[],
        fileIds: fileProofs?.getRecentAvailableIds({anidbId})??[] });
      return verifyCachedPositiveCoverage({ request, cached,
        cache: acquisitionCoverageCache, now,
        readWitnessVersion:()=>directAvailability.getWitnessVersion(),
        isWitnessCurrent:input=>directAvailability.isWitnessCurrent(input),
        ownedEpisodeIds:episodeIds.filter(episodeId=>inventory.getObservedFileIds({anidbId,episodeId}).length>0),
        readRevision:target=>JSON.stringify([plexObserver.getScopeGeneration(),
          inventory.getObservedFileIds(target).map(fileId=>[fileId,inventory.getFile(fileId)?.observedMs]),
          directAvailability.getObservation(target)?.observedMs]),
        readShoko:target=>readShokoEpisodeFiles({baseUrl:shokoBaseUrl,apiKey:shokoApiKey,...target,purpose:'availability',fetchImpl}),
        readPublic:(target,shoko)=>plexObserver.observeTarget(target,shoko,{includeProof:true}) });
    };
    const releaseSelection=discoverCandidates&&previewCandidate?createReleaseSelection({
      requests,discoverCandidates,previewCandidate,readGroupRegistry,readPublicCoverage:readRequestCoverage,
      loadDetail:input=>loadCurrentDetail(input),
      wake:id=>acquisitionRuntime?.wakeRequest(id),now }):undefined;
    releasePreviews = releaseSelection ? createReleasePreviews({requests,prepare:preparePreview,now,
      selectionOptions:{discoverCandidates,previewCandidate,readGroupRegistry,readPublicCoverage:readRequestCoverage,
        loadDetail:input=>loadCurrentDetail(input)},
      wake:id=>acquisitionRuntime?.wakeRequest(id),
      onCommitted: result=>autoTrackSavedAiringRequest({result,requesterId:result.requesterId,
        anidbId:result.anidbId,readRequest:id=>requests.getRequest(id),accounts})}) : undefined;
    const readAiringDetail = ({ anidbId }) => collectAniDbDetail({ anidbId,
      loadPage: async ({ page }) => {
        if (page > 1) await sleep(250);
        return loadCurrentDetail({ anidbId, page });
      } });
    // Background watches re-check 18+ access each time they add episodes.
    const watchAdultAllowed = ({ requesterId }) =>
      accounts.getActiveUser({ userId: requesterId })?.adultAllowed === true;
    const wakeRelease = createReleaseWake({
      wakeRequest: (id) => acquisitionRuntime?.wakeRequest(id),
      pollWatch: (requestId, {releaseTitles = []}) => pollAiringWatches({ ledger: requests,
        requestId, expectedEpisodeNumbers:observedReleaseEpisodes(releaseTitles),
        hydrateMetadata:shokoHydration ? hydrateAndWake : null,
        adultAllowed: watchAdultAllowed,
        today: today(), nowMs: now(), loadDetail: readAiringDetail }),
    });
    const airingWorker = createAiringPageWorker({ ledger: requests,
      pollPage: ({ afterId, limit }) => pollAiringWatches({
        ledger: requests, afterId, limit, today: today(), nowMs: now(),
        adultAllowed: watchAdultAllowed,
        loadDetail: ({ anidbId }) => collectAniDbDetail({ anidbId,
          loadPage: async ({ page }) => {
            if (page > 1) await new Promise((resolve) => setTimeout(resolve, 250));
            return loadCurrentDetail({ anidbId, page });
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
            getHandoff: (attemptId) => handoffs.getHandoff(attemptId),
            ...(pureMoves ? { getPureMove: (attemptId) =>
              pureMoves.getIntent(attemptId) } : {}) }),
        }));
        return combineImportActivity(manual, automated, withFingerprint);
      } : null;
    let acquisitionRuntime;
    // Set once acquisition workers open; an admin release needs qBittorrent.
    let releaseProviders = null;
    const publicAvailableIdsForTitle = (anidbId, checkedMs) =>
      plexObserver ? new Set([
        ...directAvailability.getRecentAvailableIds({ anidbId, nowMs: checkedMs }),
        ...(titleChecks?.getRecentAvailableIds({ anidbId, nowMs: checkedMs }) ?? []),
        ...(fileProofs?.getRecentAvailableIds({ anidbId }) ?? []),
      ]) : new Set();
    const watchingSchedules = createWatchingScheduleReader({
      cachedIndex: (anidbId) => rawDetailReader.cachedEpisodeIndex(anidbId),
      readDetail: (input) => rawDetailReader.read(input), today, now,
      verifiedIds: (anidbId) => publicAvailableIdsForTitle(anidbId, now()),
    });
    const publicPresenceForTitle = (anidbId, checkedMs) => {
      const ids = publicAvailableIdsForTitle(anidbId, checkedMs);
      return { state: ids.size > 0 ? 'in_library' : 'unknown',
        verifiedEpisodeCount: ids.size,
        regularCoverage: ids.size?cachedRegularCoverage({index:rawDetailReader.cachedEpisodeIndex(anidbId,{includeSpecials:true}),verifiedIds:ids,asOf:today()}):undefined };
    };
    // Airing's "In library" preset must use the same current file evidence
    // as Negev's Library page. A short-lived title or direct check may inform
    // availability, but it does not place a title in the library catalogue.
    const libraryPresenceForTitle = (anidbId) => {
      const ids=new Set(fileProofs?.getRecentAvailableIds({ anidbId })??[]);
      const count=ids.size;
      return { state: count > 0 ? 'in_library' : 'unknown',
        verifiedEpisodeCount: count,
        regularCoverage: cachedRegularCoverage({index:rawDetailReader.cachedEpisodeIndex(anidbId,{includeSpecials:true}),verifiedIds:ids,asOf:today()}) };
    };
    const cachedDisplayRelations = createCachedDisplayRelations({ now,
      read: ({ anidbId }) => readDisplayRelations({
        readLocal: () => metadata.run(() => readAniDbRelatedTitles({
          baseUrl: shokoBaseUrl, apiKey: shokoApiKey, anidbId, fetchImpl,
          timeoutMs: 4_000,
        })),
        readArchive: () => readArchiveRelatedTitles({ anidbId, fetchImpl: catalogueFetch,
          timeoutMs: 4_000,
          titleForId: (id) => titleSource?.getTitle(id) ?? null }),
      }),
    });
    const app = await buildUserApp({ accounts, sessionKey, publicOrigin,
      localOrigin, secureCookies, logger,
      readImportActivity,
      getAcquisitionStatus: () => acquisitionRuntime?.getStatus() ??
        { state: 'disabled' },
      acquisitionAllowedAnidbIds,
      ownershipGate: acquisitionOwnershipGate,
      publicAvailabilityConfigured: Boolean(plexObserver),
      now, submitRequest: (input) => submitRequest(input),
      queuePendingTitle: async ({ requesterId, anidbId, requestKey,
        initialReason, releaseMode = 'auto' }) => {
        if (!Number.isSafeInteger(requesterId) || requesterId < 1 ||
            !Number.isSafeInteger(anidbId) || anidbId < 1 ||
            typeof requestKey !== 'string') {
          return { state: 'held', reason: 'invalid_request' };
        }
        // The exact submitter already confirmed this ID before returning
        // detail_pending. Rechecking here would add another provider wait.
        const title = titleSource?.getTitle(anidbId) ??
          titleRegistry.getTitle({ anidbId });
        if (typeof title !== 'string' || !title.trim() ||
            title.trim() !== title || title.length > 300 ||
            /[\x00-\x1f\x7f]/.test(title)) {
          return { state: 'held', reason: 'title_unavailable' };
        }
        return pendingTitles.enqueue({ requesterId, anidbId,
          title, requestKey, nowMs: now(), initialReason, releaseMode });
      },
      listPendingTitles: async (input) => {
        await titleSource?.refresh();
        const page = pendingTitles.listForUser(input);
        const items = await Promise.all(page.items.map(async (item) => ({ ...item,
          title: titleSource?.getTitle(item.anidbId) ?? item.title,
          englishTitle: await englishTitleFor(item.anidbId) })));
        return { ...page, items };
      },
      readPendingTitle: (id) => pendingTitles.get(id),
      readPendingTitleByKey: (input) => pendingTitles.getByKey(input),
      readActivePendingTitle: (input) => pendingTitles.getActiveForTitle(input),
      cancelPendingTitle: (input) => pendingTitles.cancel(input),
      cancelRequest: (input) => requests.cancelRequest(input),
      reviewHeldRequest: ({ requestId, action }) => {
        const queue = openAcquisitionRequestQueue(dbPath);
        try {
          const suspension = queue.getSuspension(requestId);
          const saved = requests.getRequest(requestId);
          if (suspension?.reason !== 'cutover_review' ||
              saved?.status !== 'held' || saved.canCancel !== true) {
            return { state: 'held', reason: 'not_reviewable' };
          }
          if (action === 'approve') return queue.resumeSuspended({ requestId });
          return requests.cancelRequest({ requesterId: saved.requesterId,
            requestId, nowMs: now() });
        } finally { queue.close(); }
      },
      readRequest: (id) => requests.getRequest(id),
      findActiveWatch: (input) => requests.findActiveWatch(input),
      findOtherActiveWatch: (input) => requests.findOtherActiveWatch(input),
      listRequests: async (input) => {
        await plexObserver?.ensureScope();
        void titleSource?.refresh().catch(() => {});
        const target = input.requestId ? requests.getRequest(input.requestId) : null;
        const page = input.requestId ? { items: target &&
          (input.scope === 'all' || target.requesterId === input.requesterId) ? [target] : [], nextBeforeId: null }
          : requests.listRequests(input);
        const englishTitles = page.items.map((item) => cachedEnglishTitleFor(item.anidbId));
        const ownerNames = input.scope === 'all'
          ? new Map((accounts.listUsers({ adminUserId: input.requesterId }).items ?? [])
            .map((user) => [user.id, user.username]))
          : new Map([[input.requesterId,
            accounts.getActiveUser({ userId: input.requesterId })?.username]]);
        const checkedMs = now();
        const positivesByTitle = new Map();
        return { ...page, items: page.items.map((item, index) => {
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
            coverage = recentPublicCoverage({ episodeIds: item.episodeIds, includeIds:true,
              ...positivesByTitle.get(item.anidbId) });
          }
          const releaseControl=requests.getReleaseControl(item.id,checkedMs);
          const availableEpisodeIds = coverage?.availableEpisodeIds ?? [];
          const local = progress.read(item.id,{availableEpisodeIds});
          const scheduledToday = watchingSchedules.pendingToday(item, availableEpisodeIds);
          if(coverage){const {availableEpisodeIds,...publicCoverage}=coverage;coverage=publicCoverage;}
          return { ...item,
            title: titleSource?.getTitle(item.anidbId) ??
              titleRegistry.getTitle({ anidbId: item.anidbId }) ?? item.title,
            nextAir: watchingSchedules.read(item),
            preferredWait:requests.getPreferredWait(item.id,checkedMs),
            releasePreference:item.status==='held'&&item.kind==='series'&&item.monitorFuture&&!item.watchClosed&&releaseControl.preference
              ?{group:releaseControl.preference.group,audio:releaseControl.preference.audio}:null,
            releaseSelection: (()=>{const c=releaseControl;
              return ['selecting','proposal','chosen'].includes(c.phase)
                ? {mode:c.mode,phase:c.phase,expiresMs:c.expiresMs??null}:null;})(),
            englishTitle: englishTitles[index],
            requesterName: ownerNames.get(item.requesterId) ?? `User #${item.requesterId}`,
            progress: { ...local,
              ...(coverage?.verifiedTargets > 0 ? { publicAvailability: 'verified_recently',
                publicVerifiedTargets: coverage.verifiedTargets } : {}),
              ...(scheduledToday ? { scheduledToday } : {}) } };
        }) };
      },
      searchTitles: async ({ query, page }) => {
        await plexObserver?.ensureScope();
        const withPublicPresence = (result) => {
          if (result?.state !== 'results' || !Array.isArray(result.items)) {
            return result;
          }
          const checkedMs = now();
          return { ...result, items: result.items.map((item) => {
            // 18+ is known once AniDB display data is cached (a detail view
            // reads it). Search itself stays free of extra outbound reads.
            const display = displayReader.peek({ anidbId: item.anidbId });
            return { ...item,
              ...(typeof display?.restricted === 'boolean' && typeof item.adult !== 'boolean'
                ? { adult: display.restricted } : {}),
              englishTitle: titleSource?.getEnglishTitle(item.anidbId) ?? null,
              chineseProduction: seasonalCatalogue.isChineseProduction(item.anidbId),
              libraryPresence:
              publicPresenceForTitle(item.anidbId, checkedMs),
              verifiedLibraryPresence: libraryPresenceForTitle(item.anidbId) };
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
          // Demand renewal keeps saved evidence usable without periodic workers.
          // Account/configuration reads do not wait for this public boundary.
          await plexObserver.ensureScope();
          // Title artwork and names are optional display data. A temporary
          // AniDB outage must not hide already verified public Plex files.
          void titleSource?.refresh().catch(() => {});
          const page = fileProofs.listCurrentTitles({ afterAnidbId, limit });
          const englishTitles = page.items.map((item) => cachedEnglishTitleFor(item.anidbId));
          return { state: 'current_proofs',
            items: page.items.map((item, index) => ({ ...item,
              regularCoverage:libraryPresenceForTitle(item.anidbId).regularCoverage,
              englishTitle: englishTitles[index],
              chineseProduction: seasonalCatalogue.isChineseProduction(item.anidbId),
              title: titleSource?.getTitle(item.anidbId) ??
                titleRegistry.getTitle({ anidbId: item.anidbId }) ??
                `Anime title unavailable (${item.anidbId})` })),
            nextAfterAnidbId: page.nextAfterAnidbId };
        } : undefined,
      listAiringSchedule: async ({ airingPreference } = {}) => {
        await plexObserver?.ensureScope();
        const [schedule] = await Promise.all([
          weeklySchedule.read(), titleSource?.refresh(),
        ]);
        if (!Array.isArray(schedule.items)) return schedule;
        const tracked = new Set(airingPreference?.trackedAnidbIds ?? []);
        const items = schedule.items.map((item) => ({ ...item,
          englishTitle: titleSource?.getEnglishTitle(item.anidbId) ?? null,
          chineseProduction: seasonalCatalogue.isChineseProduction(item.anidbId),
          libraryPresence: libraryPresenceForTitle(item.anidbId) }));
        return { ...schedule, items: items.filter((item) =>
          airingPreference?.mode === 'custom' ? tracked.has(item.anidbId)
            : airingPreference?.mode === 'library'
            ? item.libraryPresence.state === 'in_library' : true) };
      },
      listSeasonalTitles: async ({ airingPreference, ...input }) => {
        await plexObserver?.ensureScope();
        const checkedMs = now();
        const presence = airingPreference ? libraryPresenceForTitle
          : (anidbId) => publicPresenceForTitle(anidbId, checkedMs);
        const eligibleTitle = airingPreference?.mode === 'library'
          ? (anidbId) => presence(anidbId).state === 'in_library'
          : undefined;
        const eligibleIds = airingPreference?.mode === 'custom'
          ? new Set(airingPreference.trackedAnidbIds) : undefined;
        const [page] = await Promise.all([
          seasonalCatalogue.read({ ...input,
            ...(eligibleTitle ? { eligibleTitle } : {}),
            ...(eligibleIds ? { eligibleIds } : {}) }),
          titleSource?.refresh(),
        ]);
        if (!Array.isArray(page.items)) return page;
        return { ...page, items: page.items.map((item) => ({ ...item,
          englishTitle: item.englishTitle ??
            titleSource?.getEnglishTitle(item.anidbId) ?? null,
          libraryPresence: presence(item.anidbId) })) };
      },
      readPoster: ({ uid }) => shokoPosters.read({ uid }),
      readCataloguePoster: ({ anidbId }) => cataloguePosters.read({ anidbId }),
      readDisplayMetadata: async ({ anidbId }) => {
        await plexObserver?.ensureScope();
        const [display, facts] = await Promise.all([
          displayReader.read({ anidbId }), mapFacts.read({ anidbId }),
        ]);
        const merged = mergeDisplayFacts(display, facts);
        return merged?.state === 'display' ? { ...merged,
          englishTitle: merged.englishTitle ??
            titleSource?.getEnglishTitle(anidbId) ?? null,
          chineseProduction: seasonalCatalogue.isChineseProduction(anidbId),
          libraryPresence: publicPresenceForTitle(anidbId, now()),
          verifiedLibraryPresence: libraryPresenceForTitle(anidbId) } : merged;
      },
      loadRelatedTitles: async ({ anidbId }) => {
        await plexObserver?.ensureScope();
        const related = await cachedDisplayRelations({ anidbId });
        if (related?.state !== 'related_titles' || !Array.isArray(related.items)) {
          return related;
        }
        const checkedMs = now();
        return { ...related, items: related.items.map((item) => ({ ...item,
          chineseProduction: seasonalCatalogue.isChineseProduction(item.anidbId),
          libraryPresence: publicPresenceForTitle(item.anidbId, checkedMs) })) };
      },
      titleRegistry, confirmKnownTitle, loadDetail: async (input) => {
        const loaded = await loadFastDetail(input);
        const detail = loaded?.state === 'details' ? { ...loaded,
          title: titleSource?.getTitle(loaded.anidbId) ?? loaded.title,
          englishTitle: titleSource?.getEnglishTitle(loaded.anidbId) ?? loaded.englishTitle ?? null } : loaded;
        if (detail?.state !== 'details' || !Array.isArray(detail.episodes) ||
            detail.episodes.length > 100) return detail;
        const originalTitle = titleSource?.getTitle(detail.anidbId) ?? null;
        const releaseState = requestReleaseState(detail, today());
        const requestMode = detail.nextPage === null && detail.complete === true
          ? { monitorFuture: ['airing', 'upcoming'].includes(releaseState) }
          : {};
        // A confirmed future premiere has no public episode availability to
        // inspect. Keep the request/watch path, but skip Plex evidence work.
        if (releaseState === 'upcoming' || !plexObserver) {
          return { ...detail, originalTitle, releaseState, ...requestMode };
        }
        await plexObserver.ensureScope();
        const checkedMs = now();
        const index = detail.kind === 'series'
          ? rawDetailReader.cachedEpisodeIndex(detail.anidbId) : null;
        const cachedRegularIds = index?.totalEntries === detail.total &&
          detail.episodes.every((episode) => episode.type !== 'Episode' ||
            index.regularIds.includes(episode.id)) ? index.regularIds : null;
        const cachedRegularEpisodes = cachedRegularIds ? index.regularEpisodes : null;
        const proofBeforeRoster = publicAvailableIdsForTitle(detail.anidbId,
          checkedMs);
        // Only titles with current exact file proof need an immediate full
        // season count. Page reads use Shoko's metadata limiter and a short
        // deadline; uncertainty leaves the season count absent.
        const regularEpisodes = cachedRegularEpisodes ??
          (detail.kind === 'series' && input.page === 1 &&
            proofBeforeRoster.size > 0 ? await completeRegularRoster({ first: detail,
              includeEpisodes: true,
              loadPage: (page, remainingMs) => metadata.run(() =>
                loadAniDbDetail({ baseUrl: shokoBaseUrl,
                  apiKey: shokoApiKey, anidbId: detail.anidbId, page,
                  fetchImpl, timeoutMs: Math.min(600,
                    Math.max(1, Math.floor(remainingMs / 2))) })) }) :
          detail.kind === 'series' && detail.nextPage === null
            ? detail.episodes.filter((episode) => episode.type === 'Episode') : null);
        // A proof may expire or be withdrawn while metadata pages are read.
        const verifiedIds = publicAvailableIdsForTitle(detail.anidbId, now());
        const regularIds = regularEpisodes?.map((episode) => episode.id) ?? null;
        const regularSeason = countVerifiedRegularEpisodes({ regularIds,
          verifiedIds });
        const scheduleAsOf = today();
        const regularSchedule = regularEpisodes === null ? null :
          regularEpisodeSchedule({ episodes: regularEpisodes, asOf: scheduleAsOf,
            verifiedIds });
        return { ...detail, originalTitle, releaseState, ...requestMode,
          scheduleAsOf,
          ...(regularSeason === null ? {} : { regularSeason }),
          ...(regularSchedule === null ? {} : { regularSchedule }),
          libraryPresence: { state: verifiedIds.size > 0 ? 'in_library' : 'unknown',
            verifiedEpisodeCount: verifiedIds.size },
          episodes: detail.episodes.map((episode) => {
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
      getTitleCheck: titleChecks ? async ({ anidbId }) => {
        await plexObserver?.ensureScope();
        return titleChecks.getProgress({ anidbId, nowMs: now() });
      } : undefined,
      discoverCandidates, previewCandidate, releaseSelection, releasePreviews,
      // Admin action on one parked review item. Retry makes it due now for
      // its normal guarded worker. Release retires a never-started attempt
      // through the guarded prestart path (torrent removed without its
      // files, staging proven empty) so its episodes can be acquired again.
      deleteAccount: ({ adminUserId, userId }) => deleteAccountData(dbPath, { adminUserId, userId }),
      reviewOperationalItem: async ({ stage, attemptId, action, actorId }) => {
        if (stopping) return { state: 'held', reason: 'service_stopping' };
        const nowMs = now();
        if (action === 'retry') {
          if (stage === 'start_hold') {
            return startReview.retryReview({ attemptId, actorId, nowMs });
          }
          if (stage === 'import_hold') {
            return publishReview.retryReview({ attemptId, actorId, nowMs });
          }
          return { state: 'held', reason: 'action_unavailable' };
        }
        if (action !== 'release' || stage !== 'start_hold') {
          return { state: 'held', reason: 'action_unavailable' };
        }
        if (!releaseProviders) return { state: 'held', reason: 'release_unavailable' };
        const attempt = acquisitions.getAttempt(attemptId);
        if (attempt?.status !== 'torrent_observed' || !attempt.torrentHash) {
          return { state: 'held', reason: 'not_in_review' };
        }
        const recorded = startReview.recordReleaseRequest({ attemptId, actorId, nowMs });
        if (recorded.state !== 'release_recorded') return recorded;
        const p = releaseProviders;
        return track(runPrestartMismatchRetirement({ ledger: acquisitions,
          attemptId, hash: attempt.torrentHash, baseUrl: p.qbBaseUrl,
          stagingRoot: p.stagingHostPath, saveRoot: p.qbitStagingRoot,
          verifyStagingRoot: p.verifyStagingRoot, sessionGate: p.sessionGate, now }));
      },
      listOperationalReview: async (input) => {
        await titleSource?.refresh();
        const page = listOperationalReview({
        acquisitions, publishQueue: publishReview,
        startQueue: startReview, completionQueue: completionReview,
        shokoRescans,
        ...input });
        return page.state !== 'review' ? page : { ...page, items: page.items.map(item => ({ ...item,
          title: titleSource?.getTitle(item.anidbId) ??
            titleRegistry.getTitle({ anidbId: item.anidbId }) ?? requests.getRequest(item.requestId)?.title ?? `Anime ${item.anidbId}`,
          englishTitle: titleSource?.getEnglishTitle(item.anidbId) ?? null })) };
      },
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
      hydrateTitle: shokoHydration ? hydrateAndWake : undefined,
      observePublicTarget: (target) => plexObserver ?
        observeDisplayPublic(target) :
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
        const pathTokens=eventConsumer?.snapshotPendingPathResolutions()??[];
        const startingRevision = inventory.getFile(fileId)?.observedMs;
        const startingGeneration = startingRevision === undefined ?
          eventConsumer?.getState().generation : null;
        const result = await metadata.run(() => readShokoOneFile({
          baseUrl: shokoBaseUrl, apiKey: shokoApiKey, fileId, fetchImpl, includePaths:pathTokens.length>0,
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
        for(const token of pathTokens)for(const path of result.observedPaths??[]) {
          eventConsumer.acknowledgeLinkedPathObservation({token,fileId,path,result:{...saved,recognition:inventory.getFile(fileId)?.state}});
        }
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
      readFileIdPage: (input) => metadata.run(() => readShokoFileIdPage({
        baseUrl: shokoBaseUrl, apiKey: shokoApiKey, ...input, fetchImpl,
      })),
      isKnownFileId: (fileId) => inventory.getFile(fileId)?.state === 'linked',
      refreshFile: refreshRecognizedShokoFile,
    }) : null;
    eventConsumer = createShokoEventConsumer({
      ...([shokoImportFolderId, acquisitionImportFolderId].some(id => Number.isSafeInteger(id) && id > 0) ? {
        intakeFolderIds: [...new Set([shokoImportFolderId, acquisitionImportFolderId].filter(id => Number.isSafeInteger(id) && id > 0))],
      } : {}),
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
    const reconcileMissingDetectedPaths = async () => {
      const tokens=eventConsumer.snapshotPendingPathResolutions();
      if(!tokens.length||readShokoConnectionState()?.state!=='connected')return;
      const generation=eventConsumer.getState().generation;
      for(const [importRoot,managedFolderId] of [[shokoImportRoot,shokoImportFolderId],
          [acquisitionImportParent,acquisitionImportFolderId]]){
        if(importRoot===null||managedFolderId===null||!tokens.some(token=>token.key.startsWith(managedFolderId+':')))continue;
        const observation=await metadata.run(()=>readShokoImportActivity({baseUrl:shokoBaseUrl,
          apiKey:shokoApiKey,fetchImpl,importRoot,managedFolderId,withFingerprint:true,includeObservedPaths:true,now,
          maxBaselineEntries:importRoot===acquisitionImportParent&&pureMoves?1000:256,
          ...(importRoot===shokoImportRoot&&qbitSidecarObserver!==null?{
            readSidecarTorrent:qbitSidecarObserver.readTorrent,qbitImportSavePath:qbitSidecarObserver.importSavePath}:{}),
        }));
        if(readShokoConnectionState()?.state==='connected')eventConsumer.acknowledgeMissingPathObservations({tokens,generation,managedFolderId,observation});
      }
    };
    const fullReconciliation = createShokoFullReconciliation({ ledger: inventory,
      consumer: eventConsumer, readConnectionState: readShokoConnectionState,
      tickPage: () => inventoryWorker.tick() });
    const readImportFeed = () => importFeedState({
      connection: readShokoConnectionState(),
      event: eventConsumer.getState(),
      arrival: eventConsumer.getArrivalState(),
    });
    const observeFirstTimeUncertain = (input) => {
      if (stopping) return Promise.resolve({ state: 'held',
        reason: 'service_stopping' });
      if (!plexObserver) {
        return Promise.resolve({ state: 'held',
          reason: 'first_time_observer_unconfigured' });
      }
      const publicLibraryIds = input?.kind === 'movie'
        ? [...plex.publicSections.episode, ...plex.publicSections.movie]
        : [...plex.publicSections.episode];
      return track((async () => {
        if((await plexObserver.ensureScope()).state!=='ready') return {state:'held',reason:'availability_unavailable'};
        const metadataCache = new Map();
        const observation = await metadata.run(() => collectTargetScopedUncertain({ ...input,
        publicLibraryIds, now,
        readEpisode: (target) => readShokoEpisodeFiles({ baseUrl: shokoBaseUrl,
          apiKey: shokoApiKey, ...target, purpose: 'first_time', fetchImpl, metadataCache }),
        probePublic: (target) => plexObserver.probeFirstTimeSections(target),
        }));
        if (observation?.state === 'busy') return { state: 'held', reason: 'metadata_reader_busy' };
        return refreshFirstTimeMetadata({ anidbId: input.anidbId,
          episodeIds: input.episodeIds, observation,
          pendingClaim: hydration.getActiveClaim(now()),
          hydrate: ({ anidbId, missingEpisodeId }) =>
            hydrateAndWake({ anidbId, missingEpisodeId }) });
      })());
    };
    return { app,
      // Used by the release dialog's selection service; exposed for tests.
      discoverCandidates, previewCandidate,
      ensurePublicAvailabilityScope: () => plexObserver ? track(plexObserver.ensureScope()) : Promise.resolve({state:'ready'}),
      cachedReleaseAliases: (anidbId) =>
        titleSource?.releaseQueries(anidbId) ?? [],
      hasRecentArrival: () => now() < recentImportUntilMs,
      tickPendingTitle: () => stopping
        ? Promise.resolve({ state: 'held', reason: 'service_stopping' })
        : track(pendingTitleWorker.runOnce()),
      pollAiringNextPage: () => {
        if (stopping) return Promise.resolve({ state: 'held', reason: 'service_stopping' });
        return track(airingWorker.runOnce());
      },
      tickShokoInventory: () => {
        if (stopping) return Promise.resolve({ state: 'held', reason: 'service_stopping' });
        return track((async()=>{await reconcileMissingDetectedPaths();return fullReconciliation.tick();})());
      },
      tickShokoProvisional: async () => {
        if (stopping) return { state: 'held', reason: 'service_stopping' };
        const observedMs = now();
        const beforeMs = observedMs - 5 * 60_000;
        if (!Number.isSafeInteger(beforeMs) || beforeMs < 0) {
          return { state: 'idle' };
        }
        const candidate = inventory.getOldestProvisionalFile({ beforeMs });
        if (!candidate) return { state: 'idle' };
        // One Shoko GET per paced tick. A failed read cannot pin later files.
        inventory.recordProvisionalRecheck({ fileId: candidate.fileId,
          attemptedMs: observedMs });
        return refreshShokoFile(candidate.fileId);
      },
      tickShokoRecentScan: () => {
        if (stopping) return Promise.resolve({ state: 'held', reason: 'service_stopping' });
        if (!recentWorker) return Promise.resolve({ state: 'held',
          reason: 'recent_observer_disabled' });
        const generation = eventConsumer.getState().generation;
        return track((async () => {
          await reconcileMissingDetectedPaths();
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
        shokoProviderId, shokoSourcePath, allowedAnidbIds,
        ownershipGate, readPacer,
        pureMode = false } = {}) {
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
        if (typeof verifyStagingRoot === 'function') {
          releaseProviders = { qbBaseUrl, sessionGate, stagingHostPath,
            qbitStagingRoot, verifyStagingRoot };
        }
        acquisitionRuntime = openAcquisitionRuntime({ enabled: true,
          dbPath, requests, acquisitions, handoffs, pureMoves,
          recognitionRecoveries, shokoRescans, pureMode,
          qbBaseUrl, sessionGate,
          stagingHostPath, qbitStagingRoot, holdingRoot, importRoot,
          inspectMounts, verifyStagingRoot, verifyShokoSource,
          realpathImpl, readPacer, fetchImpl, now,
          allowedAnidbIds, ownershipGate, canAcquireRestrictedBonuses, authorizeRequest,
          readRelatedTitles,
          shoko: { baseUrl: shokoBaseUrl, apiKey: shokoApiKey,
            providerId: shokoProviderId },
          publicSections: plex.publicSections, prowlarr,
          shokoMount: plex.shokoMount, shokoSourcePath,
          firstTimePolicy: 'single_uncertain_attempt',
          observePublicTarget: (target) =>
            observeCurrentPublic(target, undefined, true),
          readPublicCoverage: readRequestCoverage,
          discoverCandidates, previewCandidate, releaseQueries,
          selectAutoRelease: releaseSelection ? (id, revision) => releaseSelection.auto(id, revision) : undefined,
          hydrateMetadata: shokoHydration ? hydrateAndWake : null,
          loadDetail: ({ anidbId }) => collectAniDbDetail({ anidbId,
            loadPage: async ({ page }) => {
              if (page > 1) await sleep(250);
              return loadCurrentDetail({ anidbId, page });
            } }),
          readEvidence: observeFirstTimeUncertain,
        });
        return acquisitionRuntime;
      },
      wakeReleaseRequest: (requestId, notification) => stopping ? Promise.resolve() : track(wakeRelease(requestId, notification)),
      getObservedShokoFileIds: (input) => inventory.getObservedFileIds(input),
      close() {
        if (!stopPromise) {
          stopping = true;
          stopPromise = (async () => {
            await wakeRelease.close();
            try { await app.close(); }
            finally {
              await acquisitionRuntime?.stop();
              await eventConsumer.close();
              await Promise.allSettled([...observations]);
              plexObserver?.close();
              scoreCache?.close(); rankings?.close(); seasonalSnapshot?.close();
              fileProofs?.close(); fileCursor?.close();
              directAvailability.close();
              titleChecks?.close();
              recent?.close();
              inventory.close(); hydration.close(); progress.close();
              completionReview.close(); startReview.close(); publishReview.close();
              shokoRescans?.close(); recognitionRecoveries?.close();
              pureMoves?.close();
              candidateChecks?.close(); handoffs.close(); acquisitions.close();
              pendingTitles.close(); requests.close(); accounts.close();
            }
          })();
        }
        return stopPromise;
      } };
  } catch (error) {
    plexObserver?.close(); fileProofs?.close(); fileCursor?.close();
    scoreCache?.close(); rankings?.close(); seasonalSnapshot?.close();
    directAvailability?.close(); titleChecks?.close(); recent?.close();
    inventory?.close(); hydration?.close();
    progress?.close(); completionReview?.close(); startReview?.close();
    publishReview?.close();
    shokoRescans?.close(); recognitionRecoveries?.close(); pureMoves?.close();
    candidateChecks?.close(); handoffs?.close(); acquisitions?.close();
    pendingTitles?.close(); requests?.close(); accounts?.close();
    throw error;
  }
}
