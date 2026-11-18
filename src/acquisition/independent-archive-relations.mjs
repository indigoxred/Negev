import { readAniDbRelatedTitles } from '../catalogue/anidb-related-titles.mjs';

// AniDB archive reads must remain independent of the single-operation Shoko
// limiter. A busy Shoko read is exactly when this fallback is needed.
export function createArchiveRelationReader({ titleSource, fetchImpl = fetch,
  readArchive = readAniDbRelatedTitles } = {}) {
  if (typeof readArchive !== 'function' || typeof fetchImpl !== 'function') {
    throw new TypeError('Invalid AniDB archive reader');
  }
  return async ({ anidbId }) => {
    const status = await titleSource?.refresh();
    if (!['ready', 'stale'].includes(status?.state)) {
      return { state: 'unavailable' };
    }
    return readArchive({ anidbId,
      titleForId: (id) => titleSource.getTitle(id), fetchImpl });
  };
}
