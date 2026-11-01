import { collectUnimportedTargets } from './collect-unimported-targets.mjs';

const validId = (id) => Number.isSafeInteger(id) && id > 0;
const held = (reason) => ({ state: 'held', reason });
const scopedFence = (item, anidbId, episodeIds) =>
  item?.state === 'settled' && item.anidbId === anidbId &&
  Array.isArray(item.episodeIds) &&
  item.episodeIds.length === episodeIds.length &&
  new Set(item.episodeIds).size === episodeIds.length &&
  episodeIds.every((id) => item.episodeIds.includes(id)) &&
  typeof item.fingerprint === 'string' && item.fingerprint.length > 0 &&
  Number.isSafeInteger(item.observedAtMs) && item.observedAtMs >= 0;

// Read-only first-time evidence composition. The caller's Import reader must
// independently prove a target-scoped settled fence; quiet_observed is not
// sufficient. The Plex reader must enumerate every configured public section,
// rather than consulting the positive-only card index.
export async function collectFirstTimeAbsence({ anidbId, episodeIds,
  publicLibraryIds, readEpisode, readPublic, readImport,
  now = Date.now } = {}) {
  if (!validId(anidbId) || !Array.isArray(episodeIds) ||
      episodeIds.length < 1 || episodeIds.length > 50 ||
      episodeIds.some((id) => !validId(id)) ||
      new Set(episodeIds).size !== episodeIds.length ||
      !Array.isArray(publicLibraryIds) || publicLibraryIds.length < 1 ||
      publicLibraryIds.length > 20 ||
      publicLibraryIds.some((id) => !validId(id)) ||
      new Set(publicLibraryIds).size !== publicLibraryIds.length ||
      [readEpisode, readPublic, readImport, now].some((fn) =>
        typeof fn !== 'function')) {
    throw new TypeError('Invalid first-time absence collector');
  }
  const scope = { anidbId, episodeIds: [...episodeIds] };
  let before;
  try { before = await readImport(scope); }
  catch { return held('import_activity_unverified'); }
  if (!scopedFence(before, anidbId, episodeIds)) {
    return held('import_activity_unverified');
  }
  const shoko = await collectUnimportedTargets({ ...scope, readEpisode });
  if (shoko.state !== 'unimported_targets') return shoko;
  let plex;
  try { plex = await readPublic({ ...scope,
    libraryIds: [...publicLibraryIds] }); }
  catch { return held('public_absence_unverified'); }
  if (plex?.state !== 'ok' || plex.complete !== true ||
      !Array.isArray(plex.libraryIds) ||
      plex.libraryIds.length !== publicLibraryIds.length ||
      new Set(plex.libraryIds).size !== publicLibraryIds.length ||
      publicLibraryIds.some((id) => !plex.libraryIds.includes(id)) ||
      !Array.isArray(plex.parts) || plex.parts.length !== 0) {
    return held('public_absence_unverified');
  }
  let after;
  try { after = await readImport(scope); }
  catch { return held('import_activity_unverified'); }
  const observedAtMs = now();
  if (!scopedFence(after, anidbId, episodeIds) ||
      before.fingerprint !== after.fingerprint ||
      !Number.isSafeInteger(observedAtMs) || observedAtMs < 0 ||
      before.observedAtMs > after.observedAtMs ||
      after.observedAtMs > observedAtMs ||
      observedAtMs - before.observedAtMs > 30_000) {
    return held('import_activity_unverified');
  }
  return { ...scope, observedAtMs, shoko,
    plex: { state: 'ok', complete: true,
      libraryIds: [...publicLibraryIds], parts: [] },
    importFence: { state: 'settled', ...scope,
      beforeObservedAtMs: before.observedAtMs,
      afterObservedAtMs: after.observedAtMs } };
}
