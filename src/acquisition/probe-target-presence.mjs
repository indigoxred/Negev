const validId = (value) => Number.isSafeInteger(value) && value > 0;
const unknown = (episodeId, reason) => ({ episodeId, state: 'unknown', reason });

// Read-only triage for a small request subset. Neither an empty Shoko result
// nor an idle import queue authorizes a download: the public Plex catalogue
// and an in-flight manual import may still disagree with this observation.
export async function probeTargetPresence({ anidbId, episodeIds, kind,
  readShokoEpisode, readPublicTarget, readImportActivity,
  now = Date.now } = {}) {
  if (!validId(anidbId) || !Array.isArray(episodeIds) ||
      episodeIds.length < 1 || episodeIds.length > 10 ||
      episodeIds.some((id) => !validId(id)) ||
      new Set(episodeIds).size !== episodeIds.length ||
      !['series', 'movie'].includes(kind) ||
      [readShokoEpisode, readPublicTarget, readImportActivity, now]
        .some((fn) => typeof fn !== 'function')) {
    throw new TypeError('Invalid acquisition presence probe');
  }
  let before;
  try { before = await readImportActivity(); }
  catch { before = { state: 'unavailable' }; }
  const observations = [];
  for (const episodeId of episodeIds) {
    const target = { anidbId, episodeId, kind };
    let shoko, publicResult;
    try { shoko = await readShokoEpisode(target); }
    catch { shoko = { state: 'unavailable' }; }
    try { publicResult = await readPublicTarget(target, shoko); }
    catch { publicResult = { state: 'unknown' }; }
    observations.push({ episodeId, shoko, publicResult });
  }
  let after;
  try { after = await readImportActivity(); }
  catch { after = { state: 'unavailable' }; }
  const observedAtMs = now();
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) {
    return { state: 'held', reason: 'invalid_clock' };
  }
  const quiet = before?.state === 'quiet_observed' &&
    after?.state === 'quiet_observed';
  const importActive = [before?.state, after?.state]
    .some((state) => state === 'busy' || state === 'unsettled');
  const targets = observations.map(({ episodeId, shoko, publicResult }) => {
    const files = shoko?.files;
    const complete = shoko?.state === 'ok' && shoko.complete === true &&
      Array.isArray(files);
    const present = shoko?.state === 'ok' && Array.isArray(files) &&
      files.some((file) => validId(file?.fileId) &&
        Array.isArray(file.episodeIds) && file.episodeIds.includes(episodeId));
    if (present) return publicResult?.state === 'available'
      ? { episodeId, state: 'available', reason: 'public_plex_verified' }
      : { episodeId, state: 'present_in_shoko', reason: 'awaiting_public_plex' };
    if (publicResult?.state === 'available') {
      return unknown(episodeId, 'conflicting_observers');
    }
    if (shoko?.state !== 'not_imported' && !(complete && files.length === 0)) {
      return unknown(episodeId, 'observer_unavailable');
    }
    return quiet ? unknown(episodeId, 'locally_missing_unconfirmed') :
      unknown(episodeId, importActive ? 'import_in_progress' :
        'observer_unavailable');
  });
  return { state: 'probe', observedAtMs, targets };
}
