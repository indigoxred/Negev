import { checkedPublicCoverage } from './checked-public-coverage.mjs';
import { MAX_ACQUISITION_TARGETS } from './torrent-file-limits.mjs';
import { confirmMissingTargets } from './confirm-missing-targets.mjs';
import { checkAcquisitionAccess } from './acquisition-access.mjs';

const held = (reason, episodeId) => ({ state: 'held', reason,
  ...(episodeId === undefined ? {} : { episodeId }) });
const validId = (id) => Number.isSafeInteger(id) && id > 0;

// The observation must be one fresh, complete snapshot for the chosen
// targets. A Shoko import waiting for Plex is not an absent target.
export async function reserveMissingTargets({ request, candidate, episodeIds,
  readEvidence, readPublicCoverage, publicLibraryIds, ledger, authorizeRequest,
  firstTimePolicy = 'strict', now = Date.now, beforeReserve, preparedHash, plannedFiles }) {
  if (!validId(request?.id) || !validId(request.anidbId) || request.status !== 'held' ||
      !Array.isArray(request.episodeIds) || request.episodeIds.length === 0 ||
      request.episodeIds.some((id) => !validId(id)) ||
      !Array.isArray(episodeIds) || episodeIds.length === 0 || episodeIds.length > MAX_ACQUISITION_TARGETS ||
      episodeIds.some((id) => !validId(id) || !request.episodeIds.includes(id)) ||
      new Set(episodeIds).size !== episodeIds.length ||
      !validId(candidate?.indexerId) || typeof candidate.guid !== 'string' || !candidate.guid ||
      !Array.isArray(publicLibraryIds) || publicLibraryIds.length === 0 ||
      publicLibraryIds.some((id) => !validId(id)) ||
      typeof readEvidence !== 'function' || typeof ledger?.reserve !== 'function' ||
      (beforeReserve !== undefined && typeof beforeReserve !== 'function') ||
      !['strict', 'single_uncertain_attempt'].includes(firstTimePolicy) ||
      typeof now !== 'function') {
    throw new TypeError('Invalid missing-target reservation');
  }
  // An observed torrent already owns these exact targets. Report that
  // ownership before asking for a new absence fence, which may be temporarily
  // unavailable while Shoko is processing the earlier download. This path
  // never reserves a new attempt or authorizes a second torrent send.
  let owned;
  try { owned = ledger.getOwnedObservedCandidate?.({ requestId: request.id,
    candidate, episodeIds }); }
  catch { return held('claim_unavailable'); }
  if (owned !== undefined && owned !== null) {
    return owned.state === 'owned_observed' && validId(owned.attemptId) ?
      { state: 'existing', attemptId: owned.attemptId,
        status: 'torrent_observed' } : held('claim_unavailable');
  }
  const access = await checkAcquisitionAccess(authorizeRequest, { requestId: request.id });
  if (access.state === 'held') return access;
  const checked = await confirmMissingTargets({ request, episodeIds,
    readEvidence, publicLibraryIds, firstTimePolicy, now });
  if (checked.state !== 'missing_confirmed') return checked;
  if (beforeReserve) {
    let preflight;
    try { preflight = await beforeReserve(); }
    catch { return held('candidate_preflight_unavailable'); }
    if (preflight?.state !== 'ready') return preflight?.state === 'held' &&
      typeof preflight.reason === 'string' ? preflight :
      held('candidate_preflight_unavailable');
  }
  const coverage = await checkedPublicCoverage(readPublicCoverage, request, now);
  if (coverage.state === 'held') return coverage;
  return ledger.reserve({ requestId: request.id, candidate, episodeIds, availableEpisodeIds:coverage.availableEpisodeIds, restricted: access.restricted,
    ...(preparedHash===undefined?{}:{preparedHash,plannedFiles}),
    evidencePolicy: checked.evidencePolicy ?? 'strict',
    nowMs: checked.checkedAtMs });
}
