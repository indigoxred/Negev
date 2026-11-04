import { confirmMissingTargets } from './confirm-missing-targets.mjs';

const held = (reason, episodeId) => ({ state: 'held', reason,
  ...(episodeId === undefined ? {} : { episodeId }) });
const validId = (id) => Number.isSafeInteger(id) && id > 0;

// The observation must be one fresh, complete snapshot for the chosen
// targets. A Shoko import waiting for Plex is not an absent target.
export async function reserveMissingTargets({ request, candidate, episodeIds,
  readEvidence, publicLibraryIds, ledger,
  firstTimePolicy = 'strict', now = Date.now }) {
  if (!validId(request?.id) || !validId(request.anidbId) || request.status !== 'held' ||
      !Array.isArray(request.episodeIds) || request.episodeIds.length === 0 ||
      request.episodeIds.some((id) => !validId(id)) ||
      !Array.isArray(episodeIds) || episodeIds.length === 0 || episodeIds.length > 50 ||
      episodeIds.some((id) => !validId(id) || !request.episodeIds.includes(id)) ||
      new Set(episodeIds).size !== episodeIds.length ||
      !validId(candidate?.indexerId) || typeof candidate.guid !== 'string' || !candidate.guid ||
      !Array.isArray(publicLibraryIds) || publicLibraryIds.length === 0 ||
      publicLibraryIds.some((id) => !validId(id)) ||
      typeof readEvidence !== 'function' || typeof ledger?.reserve !== 'function' ||
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
  const checked = await confirmMissingTargets({ request, episodeIds,
    readEvidence, publicLibraryIds, firstTimePolicy, now });
  if (checked.state !== 'missing_confirmed') return checked;
  return ledger.reserve({ requestId: request.id, candidate, episodeIds,
    evidencePolicy: checked.evidencePolicy ?? 'strict',
    nowMs: checked.checkedAtMs });
}
