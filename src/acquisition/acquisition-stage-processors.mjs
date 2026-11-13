import { createAcquisitionRequestProcessor } from './acquisition-request-processor.mjs';
import { submitMissingCandidate } from './submit-missing-candidate.mjs';
import { processRecordedStart } from './process-recorded-start.mjs';
import { processCompletedAttempt } from './process-completed-attempt.mjs';
import { checkExistingShokoBatch } from './existing-shoko-batch.mjs';
import { readShokoEpisodeFiles } from '../availability/shoko-episode-files.mjs';
import { processRecordedHandoff } from './process-recorded-handoff.mjs';
import { processPureCompletedAttempt } from './process-pure-completed-attempt.mjs';
import { processPurePublish } from './process-pure-publish.mjs';
import { previewAniDbRelease } from '../identity/shoko-preview.mjs';
import { previewOfflineRelease } from '../identity/shoko-offline-preview.mjs';
import { verifyHandoffMountRoots } from './handoff-mount-roots.mjs';
import { ensureImportChild } from './ensure-import-child.mjs';
import { ED2K_CHUNK_SIZE } from '../identity/ed2k.mjs';
import { readShokoEd2kMode } from '../identity/shoko-ed2k-mode.mjs';
import { readAniDbRelatedTitles } from '../catalogue/shoko-related-titles.mjs';

const validId = (value) => Number.isSafeInteger(value) && value > 0;
const held = (reason) => ({ state: 'held', reason });

// Bind the real guarded stages to one service's journals and providers. This
// does not create a timer or perform I/O. The caller must still prove installed
// availability, path, credential and Import gates before starting a pipeline.
export function createAcquisitionStageProcessors({ requests, acquisitions,
  handoffs, pureMoves = null, pureMode = false,
  discoverCandidates, previewCandidate, loadDetail,
  releaseQueries, readEvidence, readPublicCoverage, publicSections, prowlarr,
  stagingHostPath, qbitStagingRoot, holdingRoot, importRoot, inspectMounts,
  verifyStagingRoot, realpathImpl,
  verifyShokoSource,
  readRelatedTitles,
  ownershipGate = null,
  shoko, providerFetchImpl = fetch, readPacer, now = Date.now,
  verifyHandoffMounts = verifyHandoffMountRoots,
  ensureImportRoot = ensureImportChild,
  readEd2kMode = readShokoEd2kMode,
  firstTimePolicy = 'strict' } = {}) {
  const episode = publicSections?.episode;
  const movie = publicSections?.movie;
  if (typeof requests?.getRequest !== 'function' ||
      typeof acquisitions?.getAttempt !== 'function' ||
      typeof handoffs?.getHandoff !== 'function' ||
      typeof pureMode !== 'boolean' ||
      (pureMode && (typeof pureMoves?.getIntent !== 'function' ||
        typeof pureMoves?.recordIntent !== 'function' ||
        typeof pureMoves?.markPrepared !== 'function')) ||
      [discoverCandidates, previewCandidate, loadDetail, releaseQueries,
        readEvidence, readPublicCoverage, realpathImpl, providerFetchImpl, now,
        verifyHandoffMounts, ensureImportRoot, readEd2kMode,
        verifyShokoSource]
        .some((fn) => typeof fn !== 'function') ||
      !Array.isArray(episode) || episode.length < 1 || episode.length > 20 ||
      !Array.isArray(movie) || movie.length > 20 ||
      [...episode, ...movie].some((id) => !validId(id)) ||
      new Set([...episode, ...movie]).size !== episode.length + movie.length ||
      !['strict', 'single_uncertain_attempt'].includes(firstTimePolicy) ||
      typeof prowlarr?.baseUrl !== 'string' ||
      typeof prowlarr?.apiKey !== 'string' ||
      !Array.isArray(prowlarr?.indexerIds) ||
      typeof shoko?.baseUrl !== 'string' ||
      typeof shoko?.apiKey !== 'string' ||
      typeof shoko?.providerId !== 'string' ||
      [stagingHostPath, holdingRoot, importRoot]
        .some((value) => typeof value !== 'string' || !value) ||
      (typeof verifyStagingRoot !== 'function' && typeof inspectMounts !== 'function') ||
      (readPacer !== undefined && typeof readPacer?.afterBytes !== 'function') ||
      (readRelatedTitles !== undefined && typeof readRelatedTitles !== 'function') ||
      (ownershipGate !== null && (typeof ownershipGate?.refresh !== 'function' ||
        typeof ownershipGate?.status !== 'function'))) {
    throw new TypeError('Invalid acquisition stage providers');
  }
  const checkOwnership = async (anidbId) => {
    if (!ownershipGate) return null;
    try {
      if ((await ownershipGate.refresh())?.state !== 'ready') {
        return held('sonarr_ownership_unavailable');
      }
      const status = ownershipGate.status(anidbId);
      return status === 'eligible' ? null :
        held(status === 'owned' ? 'sonarr_title_owned' :
          status === 'unmapped' ? 'sonarr_identity_unmapped' :
            'sonarr_ownership_unavailable');
    } catch { return held('sonarr_ownership_unavailable'); }
  };
  const publicLibraryIds = (kind) => kind === 'movie'
    ? [...episode, ...movie] : [...episode];
  const relatedTitleReader = readRelatedTitles ?? (({ anidbId }) =>
    readAniDbRelatedTitles({ baseUrl: shoko.baseUrl,
      apiKey: shoko.apiKey, anidbId, fetchImpl: providerFetchImpl }));
  const lookup = ({ ed2k, size }) => previewAniDbRelease({
    baseUrl: shoko.baseUrl, providerId: shoko.providerId,
    apiKey: shoko.apiKey, ed2k, size, fetchImpl: providerFetchImpl });
  const offlineLookup = ({ filename }) => previewOfflineRelease({
    baseUrl: shoko.baseUrl, apiKey: shoko.apiKey,
    filename, fetchImpl: providerFetchImpl });
  const readHandoffEpisode = ({ anidbId, episodeId }, fetchImpl = providerFetchImpl) =>
    readShokoEpisodeFiles({ baseUrl: shoko.baseUrl, apiKey: shoko.apiKey,
      anidbId, episodeId, purpose: 'handoff', fetchImpl });
  const checkExisting = (verified, fetchImpl = providerFetchImpl) =>
    checkExistingShokoBatch({ verified,
      readEpisode: (target) => readHandoffEpisode(target, fetchImpl),
    });
  const handoffMountReady = async () => {
    try {
      if ((await verifyShokoSource())?.state !== 'verified_shoko_source') {
        return false;
      }
      const child = await ensureImportRoot({ holdingRoot, importRoot,
        verifyHandoffMounts });
      if (child?.state !== 'import_child_ready') return false;
      const result = await verifyHandoffMounts({ holdingRoot, importRoot });
      return result?.state === 'mounted_handoff_roots';
    } catch { return false; }
  };
  const stagingMountReady = async () => {
    try {
      return (await verifyStagingRoot?.())?.state === 'verified_staging_root';
    } catch { return false; }
  };
  const selectedEd2kMode = async (files) => {
    if (!Array.isArray(files) || !files.some((file) =>
      Number.isSafeInteger(file?.size) && file.size > 0 &&
      file.size % ED2K_CHUNK_SIZE === 0)) return undefined;
    try {
      const result = await readEd2kMode({ baseUrl: shoko.baseUrl,
        apiKey: shoko.apiKey, fetchImpl: providerFetchImpl });
      return result?.state === 'mode' && result.mode === 'edonkey' &&
        result.basis === 'forced_sharp' ? result.mode : null;
    } catch { return null; }
  };
  return {
    async processRequest({ qbittorrent, fetchImpl, providerFetchImpl: searchFetch,
      renewQbittorrent,
      ...claim } = {}) {
      if (typeof fetchImpl !== 'function' ||
          typeof searchFetch !== 'function' ||
          typeof qbittorrent?.baseUrl !== 'string' ||
          typeof qbittorrent?.sessionId !== 'string') {
        return Promise.resolve(held('provider_unavailable'));
      }
      if (ownershipGate) {
        let request;
        try { request = requests.getRequest(claim.requestId); }
        catch { return held('request_unavailable'); }
        const ownership = await checkOwnership(request?.anidbId);
        if (ownership) return ownership;
      }
      const process = createAcquisitionRequestProcessor({
        readRequest: (id) => requests.getRequest(id),
        readPublicCoverage,
        inspectCandidateTargets: acquisitions.inspectCandidateTargets?.bind(acquisitions),
        discoverCandidates, previewCandidate, loadDetail,
        submitCandidate: async ({ request, ...selected }) => {
          const ownership = await checkOwnership(request.anidbId);
          if (ownership) return ownership;
          return submitMissingCandidate({ request, ...selected,
            releaseQueries, readEvidence, readRelatedTitles: relatedTitleReader,
            ledger: acquisitions, firstTimePolicy,
            renewQbittorrent,
            publicLibraryIds: publicLibraryIds(request.kind), now,
            prowlarr: { ...prowlarr, fetchImpl: searchFetch },
            qbittorrent: { ...qbittorrent, hostPath: stagingHostPath,
              saveRoot: qbitStagingRoot, inspectMounts, verifyStagingRoot,
              realpathImpl, fetchImpl },
          });
        },
      });
      return process(claim);
    },
    async processStart({ attemptId, qbittorrent, fetchImpl,
      renewQbittorrent } = {}) {
      let attempt, request;
      try {
        attempt = acquisitions.getAttempt(attemptId);
        if (!attempt) return held('attempt_missing');
        request = requests.getRequest(attempt.requestId);
      } catch { return held('attempt_unavailable'); }
      if (!['series', 'movie'].includes(request?.kind)) {
        return held('request_unavailable');
      }
      const ownership = await checkOwnership(request.anidbId);
      if (ownership) return ownership;
      return processRecordedStart({ attemptId, requests, acquisitions,
        stagingHostPath, qbitStagingRoot, qbittorrent, inspectMounts,
        verifyStagingRoot, realpathImpl,
        readEvidence, publicLibraryIds: publicLibraryIds(request.kind),
        readRelatedTitles: relatedTitleReader,
        fetchImpl, renewQbittorrent, now });
    },
    async processCompletion({ attemptId, qbittorrent, fetchImpl,
      shokoFetchImpl, renewQbittorrent } = {}) {
      if (!await stagingMountReady()) return held('staging_root_unverified');
      if (!await handoffMountReady()) return held('handoff_mount_unavailable');
      if (pureMode) return processPureCompletedAttempt({ attemptId, requests,
        acquisitions, pureMoves, stagingHostPath, qbitStagingRoot,
        holdingRoot, importRoot, qbittorrent, fetchImpl,
        verifyStagingRoot: stagingMountReady, verifyHandoffMounts,
        nowMs: now() });
      let planned;
      try { planned = acquisitions.getFilePlan?.(attemptId); }
      catch { return held('file_plan_unavailable'); }
      const ed2kMode = await selectedEd2kMode(planned);
      if (ed2kMode === null) return held('ed2k_boundary_mode_unverified');
      return processCompletedAttempt({ attemptId, requests, acquisitions,
        handoffs, stagingHostPath, qbitStagingRoot, holdingRoot, importRoot,
        qbittorrent, shoko, fetchImpl, shokoFetchImpl, renewQbittorrent,
        readPacer, verifyHandoffMounts, verifyStagingRoot: stagingMountReady,
        checkExisting: (verified) => checkExisting(verified,
          shokoFetchImpl ?? providerFetchImpl),
        nowMs: now(), ed2kMode });
    },
    async processPublish({ attemptId } = {}) {
      if (pureMode) {
        if (!await handoffMountReady()) return held('handoff_mount_unavailable');
        if (!await stagingMountReady()) return held('staging_root_unverified');
        return processPurePublish({ attemptId, nowMs: now(), pureMoves,
          stagingHostPath, holdingRoot, importRoot });
      }
      let handoff;
      try { handoff = handoffs.getHandoff(attemptId); }
      catch { return held('handoff_unavailable'); }
      if (handoff?.status === 'published_observed') {
        return processRecordedHandoff({ attemptId, ledger: handoffs,
          holdingRoot, importRoot, lookup, offlineLookup,
          readPacer, nowMs: now() });
      }
      if (!await handoffMountReady()) return held('handoff_mount_unavailable');
      const ed2kMode = await selectedEd2kMode(handoff?.manifest?.videos);
      if (ed2kMode === null) return held('ed2k_boundary_mode_unverified');
      return processRecordedHandoff({ attemptId, ledger: handoffs,
        holdingRoot, importRoot, lookup, offlineLookup, readPacer, ed2kMode,
        verifyHandoffMounts, checkExisting, readEpisode: readHandoffEpisode,
        nowMs: now() });
    },
  };
}
