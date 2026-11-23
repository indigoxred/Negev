import { MAX_ACQUISITION_TARGETS } from './torrent-file-limits.mjs';
const validId = (id) => Number.isSafeInteger(id) && id > 0;

// Four-target bounded first-time Shoko observation. Each missing local episode
// must have its separate AniDB metadata row confirmed by the reader. This
// does not prove the Import watcher has settled or Plex is empty; those are
// independent gates in confirmMissingTargets.
export async function collectUnimportedTargets({ anidbId, episodeIds,
  readEpisode } = {}) {
  if (!validId(anidbId) || !Array.isArray(episodeIds) ||
      episodeIds.length < 1 || episodeIds.length > MAX_ACQUISITION_TARGETS ||
      episodeIds.some((id) => !validId(id)) ||
      new Set(episodeIds).size !== episodeIds.length ||
      typeof readEpisode !== 'function') {
    throw new TypeError('Invalid first-time target observation');
  }
  for (let offset = 0; offset < episodeIds.length; offset += 4) {
    const batch = episodeIds.slice(offset, offset + 4);
    const observations = await Promise.all(batch.map(async episodeId => {
      try { return await readEpisode({ anidbId, episodeId }); }
      catch { return null; }
    }));
    for (const [index, episodeId] of batch.entries()) {
      const observed = observations[index];
      if (observed?.state === 'busy') {
        return { state: 'held', reason: 'metadata_reader_busy', episodeId };
      }
      if (observed?.state === 'metadata_missing' &&
          observed.anidbId === anidbId && observed.episodeId === episodeId) {
        return { state: 'held', reason: 'shoko_metadata_missing', episodeId };
      }
      if (!['not_imported', 'empty_episode'].includes(observed?.state) ||
          observed.anidbId !== anidbId ||
          observed.episodeId !== episodeId) {
        return { state: 'held', reason: 'target_not_proven_unimported', episodeId };
      }
    }
  }
  return { state: 'unimported_targets', anidbId,
    episodeIds: [...episodeIds] };
}
