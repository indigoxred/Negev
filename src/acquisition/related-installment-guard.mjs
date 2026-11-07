import { matchesTrustedReleaseTitle } from './plan-torrent-targets.mjs';

const held = (reason) => ({ state: 'held', reason });

// A title can be the prefix of a separately listed sequel or side story.
// Direct AniDB relations provide conservative negative evidence before any
// bytes are downloaded; an unregistered-file fallback must repeat this check
// against current Shoko relations before it considers a User release link.
export function checkRelatedInstallment({ anidbId, requestedTitle, related,
  releaseTitle, fileNames = [] } = {}) {
  if (!Number.isSafeInteger(anidbId) || anidbId < 1 ||
      typeof requestedTitle !== 'string' || !requestedTitle.trim() ||
      related?.state !== 'related_titles' || related.anidbId !== anidbId ||
      !Array.isArray(related.items) || related.items.length > 50 ||
      !Array.isArray(fileNames) || fileNames.length < 1 || fileNames.length > 50 ||
      fileNames.some((name) => typeof name !== 'string' || !name.trim()) ||
      (releaseTitle !== undefined && typeof releaseTitle !== 'string') ||
      related.items.some((item) => !Number.isSafeInteger(item?.anidbId) ||
        item.anidbId < 1 || item.anidbId === anidbId ||
        typeof item.title !== 'string' || !item.title.trim())) {
    return held('related_title_unavailable');
  }
  const names = releaseTitle === undefined ? fileNames : [releaseTitle, ...fileNames];
  if (related.items.some((item) =>
    !matchesTrustedReleaseTitle(requestedTitle, item.title) &&
    names.some((name) => matchesTrustedReleaseTitle(name, item.title)))) {
    return held('related_installment_mismatch');
  }
  return { state: 'related_title_clear' };
}
