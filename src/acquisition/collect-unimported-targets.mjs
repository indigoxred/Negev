const validId = (id) => Number.isSafeInteger(id) && id > 0;

// Serial, bounded first-time Shoko observation. Each missing local episode
// must have its separate AniDB metadata row confirmed by the reader. This
// does not prove the Import watcher has settled or Plex is empty; those are
// independent gates in confirmMissingTargets.
export async function collectUnimportedTargets({ anidbId, episodeIds,
  readEpisode } = {}) {
  if (!validId(anidbId) || !Array.isArray(episodeIds) ||
      episodeIds.length < 1 || episodeIds.length > 50 ||
      episodeIds.some((id) => !validId(id)) ||
      new Set(episodeIds).size !== episodeIds.length ||
      typeof readEpisode !== 'function') {
    throw new TypeError('Invalid first-time target observation');
  }
  for (const episodeId of episodeIds) {
    let observed;
    try { observed = await readEpisode({ anidbId, episodeId }); }
    catch { observed = null; }
    if (observed?.state !== 'not_imported' ||
        observed.anidbId !== anidbId ||
        observed.episodeId !== episodeId) {
      return { state: 'held', reason: 'target_not_proven_unimported', episodeId };
    }
  }
  return { state: 'unimported_targets', anidbId,
    episodeIds: [...episodeIds] };
}
