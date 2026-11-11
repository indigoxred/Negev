// A missing AniDB episode metadata row is an acquisition hold, not absence.
// The existing catalogue hydrator owns the durable per-title/global rate
// limits and performs only Shoko's supported metadata refresh.
export async function refreshFirstTimeMetadata({ anidbId, episodeIds,
  observation, pendingClaim, hydrate } = {}) {
  if (!Number.isSafeInteger(anidbId) || anidbId <= 0 ||
      !Array.isArray(episodeIds) || typeof hydrate !== 'function') {
    throw new TypeError('Invalid first-time metadata refresh');
  }
  const exactMissing = observation?.state === 'held' &&
    observation.reason === 'shoko_metadata_missing' &&
    episodeIds.includes(observation.episodeId);
  const finishClaim = !exactMissing && pendingClaim?.anidbId === anidbId;
  if (!exactMissing && !finishClaim) return observation;
  try { await hydrate(exactMissing ? { anidbId,
    missingEpisodeId: observation.episodeId } : { anidbId }); }
  catch { /* The original exact hold remains in force. */ }
  return observation;
}
