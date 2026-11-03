import { createAcquisitionRequestProcessor } from './acquisition-request-processor.mjs';
import { submitMissingCandidate } from './submit-missing-candidate.mjs';
import { processRecordedStart } from './process-recorded-start.mjs';
import { processCompletedAttempt } from './process-completed-attempt.mjs';
import { processRecordedHandoff } from './process-recorded-handoff.mjs';
import { previewAniDbRelease } from '../identity/shoko-preview.mjs';
import { verifyHandoffMountRoots } from './handoff-mount-roots.mjs';
import { ensureImportChild } from './ensure-import-child.mjs';
import { ED2K_CHUNK_SIZE } from '../identity/ed2k.mjs';
import { readShokoEd2kMode } from '../identity/shoko-ed2k-mode.mjs';

const validId = (value) => Number.isSafeInteger(value) && value > 0;
const held = (reason) => ({ state: 'held', reason });

// Bind the real guarded stages to one service's journals and providers. This
// does not create a timer or perform I/O. The caller must still prove installed
// availability, path, credential and Import gates before starting a pipeline.
export function createAcquisitionStageProcessors({ requests, acquisitions,
  handoffs, discoverCandidates, previewCandidate, loadDetail,
  releaseQueries, readEvidence, readPublicCoverage, publicSections, prowlarr,
  stagingHostPath, qbitStagingRoot, holdingRoot, importRoot, inspectMounts,
  verifyStagingRoot, realpathImpl,
  verifyShokoSource,
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
      (readPacer !== undefined && typeof readPacer?.afterBytes !== 'function')) {
    throw new TypeError('Invalid acquisition stage providers');
  }
  const publicLibraryIds = (kind) => kind === 'movie'
    ? [...episode, ...movie] : [...episode];
  const lookup = ({ ed2k, size }) => previewAniDbRelease({
    baseUrl: shoko.baseUrl, providerId: shoko.providerId,
    apiKey: shoko.apiKey, ed2k, size, fetchImpl: providerFetchImpl });
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
    processRequest({ qbittorrent, fetchImpl, providerFetchImpl: searchFetch,
      ...claim } = {}) {
      if (typeof fetchImpl !== 'function' ||
          typeof searchFetch !== 'function' ||
          typeof qbittorrent?.baseUrl !== 'string' ||
          typeof qbittorrent?.sessionId !== 'string') {
        return Promise.resolve(held('provider_unavailable'));
      }
      const process = createAcquisitionRequestProcessor({
        readRequest: (id) => requests.getRequest(id),
        readPublicCoverage,
        discoverCandidates, previewCandidate, loadDetail,
        submitCandidate: ({ request, ...selected }) =>
          submitMissingCandidate({ request, ...selected,
            releaseQueries, readEvidence,
            ledger: acquisitions, firstTimePolicy,
            publicLibraryIds: publicLibraryIds(request.kind), now,
            prowlarr: { ...prowlarr, fetchImpl: searchFetch },
            qbittorrent: { ...qbittorrent, hostPath: stagingHostPath,
              saveRoot: qbitStagingRoot, inspectMounts, verifyStagingRoot,
              realpathImpl, fetchImpl },
          }),
      });
      return process(claim);
    },
    async processStart({ attemptId, qbittorrent, fetchImpl } = {}) {
      let attempt, request;
      try {
        attempt = acquisitions.getAttempt(attemptId);
        if (!attempt) return held('attempt_missing');
        request = requests.getRequest(attempt.requestId);
      } catch { return held('attempt_unavailable'); }
      if (!['series', 'movie'].includes(request?.kind)) {
        return held('request_unavailable');
      }
      return processRecordedStart({ attemptId, requests, acquisitions,
        stagingHostPath, qbitStagingRoot, qbittorrent, inspectMounts,
        verifyStagingRoot, realpathImpl,
        readEvidence, publicLibraryIds: publicLibraryIds(request.kind),
        fetchImpl, now });
    },
    async processCompletion({ attemptId, qbittorrent, fetchImpl,
      shokoFetchImpl } = {}) {
      if (!await handoffMountReady()) return held('handoff_mount_unavailable');
      let planned;
      try { planned = acquisitions.getFilePlan?.(attemptId); }
      catch { return held('file_plan_unavailable'); }
      const ed2kMode = await selectedEd2kMode(planned);
      if (ed2kMode === null) return held('ed2k_boundary_mode_unverified');
      return processCompletedAttempt({ attemptId, requests, acquisitions,
        handoffs, stagingHostPath, qbitStagingRoot, holdingRoot, importRoot,
        qbittorrent, shoko, fetchImpl, shokoFetchImpl,
        readPacer, verifyHandoffMounts, nowMs: now(), ed2kMode });
    },
    async processPublish({ attemptId } = {}) {
      if (!await handoffMountReady()) return held('handoff_mount_unavailable');
      let handoff;
      try { handoff = handoffs.getHandoff(attemptId); }
      catch { return held('handoff_unavailable'); }
      if (handoff?.status === 'published_observed') {
        return processRecordedHandoff({ attemptId, ledger: handoffs,
          holdingRoot, importRoot, lookup, readPacer,
          verifyHandoffMounts, nowMs: now() });
      }
      const ed2kMode = await selectedEd2kMode(handoff?.manifest?.videos);
      if (ed2kMode === null) return held('ed2k_boundary_mode_unverified');
      return processRecordedHandoff({ attemptId, ledger: handoffs,
        holdingRoot, importRoot, lookup, readPacer, ed2kMode,
        verifyHandoffMounts, nowMs: now() });
    },
  };
}
