import { evaluateExactAvailability } from '../availability/exact-availability.mjs';

const validId = (id) => Number.isSafeInteger(id) && id > 0;
const held = (reason, episodeId) => ({ state: 'held', reason,
  ...(episodeId === undefined ? {} : { episodeId }) });

// Shared positive absence gate for reservation and the later torrent start.
// A stale reservation never authorizes a fresh qBittorrent start by itself.
export async function confirmMissingTargets({ request, episodeIds,
  readEvidence, publicLibraryIds, now = Date.now } = {}) {
  if (!validId(request?.id) || !validId(request.anidbId) ||
      !Array.isArray(episodeIds) || episodeIds.length < 1 || episodeIds.length > 50 ||
      episodeIds.some((id) => !validId(id)) ||
      new Set(episodeIds).size !== episodeIds.length ||
      !Array.isArray(publicLibraryIds) || publicLibraryIds.length < 1 ||
      publicLibraryIds.some((id) => !validId(id)) ||
      new Set(publicLibraryIds).size !== publicLibraryIds.length ||
      typeof readEvidence !== 'function' || typeof now !== 'function') {
    throw new TypeError('Invalid missing-target confirmation');
  }
  if (request.status !== 'held' || !Array.isArray(request.episodeIds) ||
      episodeIds.some((id) => !request.episodeIds.includes(id))) {
    return held('request_missing');
  }
  let snapshot;
  try { snapshot = await readEvidence({ anidbId: request.anidbId,
    episodeIds: [...episodeIds] }); }
  catch { return held('availability_unavailable'); }
  const checkedAtMs = now();
  if (!Number.isSafeInteger(checkedAtMs) || checkedAtMs < 0) {
    return held('availability_clock_invalid');
  }
  if (snapshot?.anidbId !== request.anidbId ||
      !Array.isArray(snapshot.episodeIds) ||
      snapshot.episodeIds.length !== episodeIds.length ||
      new Set(snapshot.episodeIds).size !== episodeIds.length ||
      episodeIds.some((id) => !snapshot.episodeIds.includes(id)) ||
      !Number.isSafeInteger(snapshot.observedAtMs) ||
      snapshot.observedAtMs > checkedAtMs ||
      checkedAtMs - snapshot.observedAtMs > 30_000) {
    return held('availability_evidence_stale');
  }
  // A scoped Plex part with no Shoko file identity may be a manual import
  // still awaiting Shoko recognition. It cannot authorize a duplicate grab.
  if (snapshot.shoko?.state === 'ok' && snapshot.shoko.complete === true &&
      snapshot.plex?.state === 'ok' && snapshot.plex.complete === true &&
      Array.isArray(snapshot.shoko.files) && snapshot.shoko.files.length === 0 &&
      Array.isArray(snapshot.plex.parts) && snapshot.plex.parts.length > 0) {
    return held('unattributed_plex_part');
  }
  for (const episodeId of episodeIds) {
    const result = evaluateExactAvailability({
      target: { anidbId: request.anidbId, episodeId },
      shoko: snapshot.shoko, plex: snapshot.plex, publicLibraryIds });
    if (result.state === 'available') return held('target_already_available', episodeId);
    if (result.state !== 'absent') return held('target_not_proven_missing', episodeId);
  }
  return { state: 'missing_confirmed', checkedAtMs };
}
