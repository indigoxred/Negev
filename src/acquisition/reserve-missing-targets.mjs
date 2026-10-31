import { evaluateExactAvailability } from '../availability/exact-availability.mjs';

const held = (reason, episodeId) => ({ state: 'held', reason,
  ...(episodeId === undefined ? {} : { episodeId }) });
const validId = (id) => Number.isSafeInteger(id) && id > 0;

// The observation must be one fresh, complete snapshot for the chosen
// targets. A Shoko import waiting for Plex is not an absent target.
export async function reserveMissingTargets({ request, candidate, episodeIds,
  readEvidence, publicLibraryIds, ledger, now = Date.now }) {
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
      typeof now !== 'function') {
    throw new TypeError('Invalid missing-target reservation');
  }
  let snapshot;
  try { snapshot = await readEvidence({ anidbId: request.anidbId, episodeIds: [...episodeIds] }); }
  catch { return held('availability_unavailable'); }
  const nowMs = now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) return held('availability_clock_invalid');
  if (snapshot?.anidbId !== request.anidbId ||
      !Array.isArray(snapshot.episodeIds) || snapshot.episodeIds.length !== episodeIds.length ||
      new Set(snapshot.episodeIds).size !== episodeIds.length ||
      episodeIds.some((id) => !snapshot.episodeIds.includes(id)) ||
      !Number.isSafeInteger(snapshot.observedAtMs) ||
      snapshot.observedAtMs > nowMs || nowMs - snapshot.observedAtMs > 30_000) {
    return held('availability_evidence_stale');
  }
  for (const episodeId of episodeIds) {
    const result = evaluateExactAvailability({ target: { anidbId: request.anidbId, episodeId },
      shoko: snapshot.shoko, plex: snapshot.plex, publicLibraryIds });
    if (result.state === 'available') return held('target_already_available', episodeId);
    if (result.state !== 'absent') return held('target_not_proven_missing', episodeId);
  }
  return ledger.reserve({ requestId: request.id, candidate, episodeIds, nowMs });
}
