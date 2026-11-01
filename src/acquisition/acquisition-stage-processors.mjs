import { createAcquisitionRequestProcessor } from './acquisition-request-processor.mjs';
import { submitMissingCandidate } from './submit-missing-candidate.mjs';
import { processRecordedStart } from './process-recorded-start.mjs';
import { processCompletedAttempt } from './process-completed-attempt.mjs';
import { processRecordedHandoff } from './process-recorded-handoff.mjs';
import { previewAniDbRelease } from '../identity/shoko-preview.mjs';

const validId = (value) => Number.isSafeInteger(value) && value > 0;
const held = (reason) => ({ state: 'held', reason });

// Bind the real guarded stages to one service's journals and providers. This
// does not create a timer or perform I/O. The caller must still prove installed
// availability, mount, credential and Import gates before starting a pipeline.
export function createAcquisitionStageProcessors({ requests, acquisitions,
  handoffs, discoverCandidates, previewCandidate, loadDetail,
  releaseQueries, readEvidence, publicSections, prowlarr,
  stagingHostPath, holdingRoot, importRoot, inspectMounts, realpathImpl,
  shoko, providerFetchImpl = fetch, readPacer, now = Date.now,
  firstTimePolicy = 'strict' } = {}) {
  const episode = publicSections?.episode;
  const movie = publicSections?.movie;
  if (typeof requests?.getRequest !== 'function' ||
      typeof acquisitions?.getAttempt !== 'function' ||
      typeof handoffs?.getHandoff !== 'function' ||
      [discoverCandidates, previewCandidate, loadDetail, releaseQueries,
        readEvidence, inspectMounts, realpathImpl, providerFetchImpl, now]
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
      (readPacer !== undefined && typeof readPacer?.afterBytes !== 'function')) {
    throw new TypeError('Invalid acquisition stage providers');
  }
  const publicLibraryIds = (kind) => kind === 'movie'
    ? [...episode, ...movie] : [...episode];
  const lookup = ({ ed2k, size }) => previewAniDbRelease({
    baseUrl: shoko.baseUrl, providerId: shoko.providerId,
    apiKey: shoko.apiKey, ed2k, size, fetchImpl: providerFetchImpl });
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
        discoverCandidates, previewCandidate, loadDetail,
        submitCandidate: ({ request, ...selected }) =>
          submitMissingCandidate({ request, ...selected,
            releaseQueries, readEvidence,
            ledger: acquisitions, firstTimePolicy,
            publicLibraryIds: publicLibraryIds(request.kind), now,
            prowlarr: { ...prowlarr, fetchImpl: searchFetch },
            qbittorrent: { ...qbittorrent, hostPath: stagingHostPath,
              inspectMounts, realpathImpl, fetchImpl },
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
        stagingHostPath, qbittorrent, inspectMounts, realpathImpl,
        readEvidence, publicLibraryIds: publicLibraryIds(request.kind),
        fetchImpl, now });
    },
    processCompletion({ attemptId, qbittorrent, fetchImpl,
      shokoFetchImpl } = {}) {
      return processCompletedAttempt({ attemptId, requests, acquisitions,
        handoffs, stagingHostPath, holdingRoot, importRoot,
        qbittorrent, shoko, fetchImpl, shokoFetchImpl,
        readPacer, nowMs: now() });
    },
    processPublish({ attemptId } = {}) {
      return processRecordedHandoff({ attemptId, ledger: handoffs,
        holdingRoot, importRoot, lookup, readPacer, nowMs: now() });
    },
  };
}
