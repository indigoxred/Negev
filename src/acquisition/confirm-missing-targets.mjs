import { evaluateExactAvailability } from '../availability/exact-availability.mjs';

const validId = (id) => Number.isSafeInteger(id) && id > 0;
const held = (reason, episodeId) => ({ state: 'held', reason,
  ...(episodeId === undefined ? {} : { episodeId }) });

// Shared positive absence gate for reservation and the later torrent start.
// A stale reservation never authorizes a fresh qBittorrent start by itself.
export async function confirmMissingTargets({ request, episodeIds,
  readEvidence, publicLibraryIds, firstTimePolicy = 'strict',
  now = Date.now } = {}) {
  if (!validId(request?.id) || !validId(request.anidbId) ||
      !Array.isArray(episodeIds) || episodeIds.length < 1 || episodeIds.length > 50 ||
      episodeIds.some((id) => !validId(id)) ||
      new Set(episodeIds).size !== episodeIds.length ||
      !Array.isArray(publicLibraryIds) || publicLibraryIds.length < 1 ||
      publicLibraryIds.some((id) => !validId(id)) ||
      new Set(publicLibraryIds).size !== publicLibraryIds.length ||
      !['strict', 'single_uncertain_attempt'].includes(firstTimePolicy) ||
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
      Array.isArray(snapshot.shoko.files) && Array.isArray(snapshot.plex.parts)) {
    // A Shoko match for some other anime or episode does not explain a
    // public Plex part observed for this requested subset. Treat it as an
    // identity conflict, not permission to acquire another copy.
    const knownStorage = new Set(snapshot.shoko.files.filter((file) =>
      file.anidbId === request.anidbId &&
      Array.isArray(file.episodeIds) &&
      file.episodeIds.some((id) => episodeIds.includes(id)))
      .map((file) => file.storageKey));
    if (snapshot.plex.parts.some((part) =>
      publicLibraryIds.includes(part.libraryId) && !knownStorage.has(part.storageKey))) {
      return held('unattributed_plex_part');
    }
  }
  // A first-time title may have no local Shoko episode row. Only a separate
  // per-target collector may summarize exact AniDB metadata confirmations;
  // a bare 404 or a partial list cannot enter this branch.
  const unimportedScope = snapshot.shoko?.state === 'unimported_targets' &&
    snapshot.shoko.anidbId === request.anidbId &&
    Array.isArray(snapshot.shoko.episodeIds) &&
    snapshot.shoko.episodeIds.length === episodeIds.length &&
    new Set(snapshot.shoko.episodeIds).size === episodeIds.length &&
    episodeIds.every((id) => snapshot.shoko.episodeIds.includes(id));
  const scopedPlex = Array.isArray(snapshot.plex?.libraryIds) &&
    snapshot.plex.libraryIds.length === publicLibraryIds.length &&
    new Set(snapshot.plex.libraryIds).size === publicLibraryIds.length &&
    publicLibraryIds.every((id) => snapshot.plex.libraryIds.includes(id));
  const noObservedPublicPart = Array.isArray(snapshot.plex?.parts) &&
    snapshot.plex.parts.length === 0;
  const strictFirstTime = unimportedScope && scopedPlex && noObservedPublicPart &&
    snapshot.plex.state === 'ok' && snapshot.plex.complete === true;
  // The owner explicitly prefers one first acquisition over indefinitely
  // holding a possible legacy Plex-only duplicate. An outage, known Part or
  // unverified Shoko target is never this narrow policy's uncertainty.
  const permissiveFirstTime = !strictFirstTime &&
    firstTimePolicy === 'single_uncertain_attempt' && unimportedScope &&
    scopedPlex && noObservedPublicPart &&
    snapshot.plex.state === 'healthy_unconfirmed';
  for (const episodeId of episodeIds) {
    if (strictFirstTime || permissiveFirstTime) continue;
    const result = evaluateExactAvailability({
      target: { anidbId: request.anidbId, episodeId },
      shoko: snapshot.shoko, plex: snapshot.plex, publicLibraryIds });
    if (result.state === 'available') return held('target_already_available', episodeId);
    if (result.state !== 'absent') return held('target_not_proven_missing', episodeId);
  }
  // Empty indexed views can precede Shoko's hashing/recognition of a manual
  // import. A future installed adapter must supply a target-scoped, bracketing
  // settled-import observation; the current queue-idle signal is insufficient.
  const fence = snapshot.importFence;
  if (fence?.state !== 'settled' || fence.anidbId !== request.anidbId ||
      !Array.isArray(fence.episodeIds) ||
      fence.episodeIds.length !== episodeIds.length ||
      episodeIds.some((id) => !fence.episodeIds.includes(id)) ||
      !Number.isSafeInteger(fence.beforeObservedAtMs) ||
      !Number.isSafeInteger(fence.afterObservedAtMs) ||
      fence.beforeObservedAtMs < 0 ||
      fence.beforeObservedAtMs > fence.afterObservedAtMs ||
      fence.afterObservedAtMs > snapshot.observedAtMs ||
      snapshot.observedAtMs - fence.beforeObservedAtMs > 30_000) {
    return held('import_activity_unverified');
  }
  return { state: 'missing_confirmed', checkedAtMs,
    ...(permissiveFirstTime ?
      { evidencePolicy: 'first_time_permissive' } : {}) };
}
