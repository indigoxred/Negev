import { matchesTrustedReleaseTitle } from './plan-torrent-targets.mjs';

const held = (reason) => ({ state: 'held', reason });
const relatedTitleVariants = (title) => {
  // Release names sometimes drop the final plural "s" of a known subtitle.
  // Apply this only to a separately identified AniDB relation, never as
  // positive evidence for the requested installment.
  const singular = title.replace(/(\p{L}{3,}[^s])s$/iu, '$1');
  return singular === title ? [title] : [title, singular];
};
const roman = { ii: 2, iii: 3, iv: 4, v: 5 };
const titleSeason = (title) => {
  const match = /\bseason[ ._-]+(ii|iii|iv|v|[2-9]\d?)\b/i.exec(title) ??
    /\b([2-9]\d?)(?:nd|rd|th)[ ._-]+season\b/i.exec(title);
  return match ? (roman[match[1].toLowerCase()] ?? Number(match[1])) : null;
};
const releaseSeasons = (name) => [
  ...name.matchAll(/(?:^|[ ._/-])s0*([2-9]\d?)(?=e\d{1,4}(?:$|[ ._/-])|$|[ ._/-])/gi),
  ...name.matchAll(/\bseason[ ._-]+([2-9]\d?)\b/gi),
].map((match) => Number(match[1]));

// A title can be the prefix of a separately listed sequel or side story.
// Direct AniDB relations provide conservative negative evidence before any
// bytes are downloaded; completed bytes still require exact AniDB proof.
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
        typeof item.title !== 'string' || !item.title.trim() ||
        (item.aliases !== undefined &&
          (!Array.isArray(item.aliases) || item.aliases.length > 20 ||
            item.aliases.some((alias) => typeof alias !== 'string' ||
              alias.length < 2 || alias.length > 120 ||
              /[\x00-\x1f\x7f]/.test(alias)))))) {
    return held('related_title_unavailable');
  }
  const names = releaseTitle === undefined ? fileNames : [releaseTitle, ...fileNames];
  const namedSeason = titleSeason(requestedTitle);
  const hasPrequel = related.items.some((item) =>
    item.relation?.toLowerCase() === 'prequel');
  const hasSequel = related.items.some((item) =>
    item.relation?.toLowerCase() === 'sequel');
  // Some indexers label a separately catalogued sequel S02 under the first
  // installment's name. Episode numbers alone must not cross that boundary.
  if (names.some((name) => releaseSeasons(name).some((season) =>
    (namedSeason !== null && season !== namedSeason) ||
    (namedSeason === null && !hasPrequel && hasSequel)))) {
    return held('related_installment_mismatch');
  }
  if (related.items.some((item) => {
    const titles = [item.title, ...(item.aliases ?? [])]
      .flatMap(relatedTitleVariants);
    return titles.every((title) =>
      !matchesTrustedReleaseTitle(requestedTitle, title)) &&
      names.some((name) => matchesTrustedReleaseTitle(name, ...titles));
  })) {
    return held('related_installment_mismatch');
  }
  return { state: 'related_title_clear' };
}
