import { MAX_ACQUISITION_VIDEOS } from './torrent-file-limits.mjs';
import { matchesTrustedReleaseTitle } from './plan-torrent-targets.mjs';

const held = (reason) => ({ state: 'held', reason });
const relatedTitleVariants = (title) => {
  // Release names sometimes drop the final plural "s" of a known subtitle.
  // Apply this only to a separately identified AniDB relation, never as
  // positive evidence for the requested installment.
  const singular = title.replace(/(\p{L}{3,}[^s])s$/iu, '$1');
  return singular === title ? [title] : [title, singular];
};
const roman = { i: 1, ii: 2, iii: 3, iv: 4, v: 5 };
const seasonTitleText = value => value.normalize('NFKC')
  .replace(/&/g, ' and ').replace(/×/g, ' x ');
// Mask only the trailing Season word belonging to a full trusted title.
// Numeric coordinates elsewhere in that same name remain negative evidence.
const maskTrustedSeasonWords = (name, titles) => {
  const leadingGroup = /^\s*\[[^\]\r\n]{1,120}\]\s*(?=\S)/u.exec(name)?.[0].length ?? 0;
  const tokens = [...name.slice(leadingGroup).matchAll(/[\p{L}\p{N}]+/gu)]
    .map(match => ({ word: match[0].toLocaleLowerCase('en'),
      start: leadingGroup + match.index, end: leadingGroup + match.index + match[0].length }));
  let masked = name;
  for (const title of titles) {
    const words = seasonTitleText(title).replace(/(?:\s*\((?:19|20)\d{2}\)|\s*\[(?:19|20)\d{2}\]|\s+(?:19|20)\d{2})\s*$/u, '').toLocaleLowerCase('en').match(/[\p{L}\p{N}]+/gu) ?? [];
    if (words.length < 2 || words.at(-1) !== 'season') continue;
    for (let i = 0; i <= tokens.length - words.length; i++) {
      if (!words.every((word, j) => tokens[i + j].word === word)) continue;
      const token = tokens[i + words.length - 1];
      masked = masked.slice(0, token.start) + ' '.repeat(token.end - token.start) + masked.slice(token.end);
    }
  }
  return masked;
};
// Explicit coordinates are negative evidence only. Ordinary episode numbers,
// catalogue years and a prequel relationship do not establish a season number.
const releaseSeasons = (name, trustedTitles = []) => {
  name = seasonTitleText(name);
  const ordinal = /(?<![\p{L}\p{N}])0*([1-9]\d?)(?:st|nd|rd|th)[ ._-]+season(?=$|[^\p{L}\p{N}])/giu;
  const ordinals = [...name.matchAll(ordinal)].map(match => Number(match[1]));
  // Do not read the episode in "2nd Season - 01" again as "Season 01".
  const remainder = maskTrustedSeasonWords(name, trustedTitles).replace(ordinal, ' ');
  return [...ordinals, ...[
    ...remainder.matchAll(/(?<![\p{L}\p{N}])season[ ._-]+(?:0*([1-9]\d?)|(i|ii|iii|iv|v))(?=$|[^\p{L}\p{N}])/giu),
    ...remainder.matchAll(/(?<![\p{L}\p{N}])s0*([1-9]\d?)(?=e\d{1,4}(?:v\d{1,2})?(?=$|[^\p{L}\p{N}])|$|[^\p{L}\p{N}])/giu),
  ].map(match => match[2] ? roman[match[2].toLowerCase()] : Number(match[1]))];
};const titleSeason = title => {
  const seasons = new Set(releaseSeasons(title));
  return seasons.size === 1 ? [...seasons][0] : null;
};
// A title can be the prefix of a separately listed sequel or side story.
// Direct AniDB relations provide conservative negative evidence before any
// bytes are downloaded; completed bytes still require exact AniDB proof.
export function checkRelatedInstallment({ anidbId, requestedTitle, requestedAliases = [], related,
  releaseTitle, fileNames = [] } = {}) {
  if (!Number.isSafeInteger(anidbId) || anidbId < 1 ||
      typeof requestedTitle !== 'string' || !requestedTitle.trim() ||
      !Array.isArray(requestedAliases) || requestedAliases.length > 50 ||
      requestedAliases.some(title => typeof title !== 'string' || title.length > 500) ||
      related?.state !== 'related_titles' || related.anidbId !== anidbId ||
      !Array.isArray(related.items) || related.items.length > 50 ||
      !Array.isArray(fileNames) || fileNames.length < 1 || fileNames.length > MAX_ACQUISITION_VIDEOS ||
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
  const aliasSeasons = new Set([requestedTitle, ...requestedAliases].map(titleSeason).filter(Boolean));
  // Conflicting aliases must not erase explicit canonical negative evidence.
  const namedSeason = titleSeason(requestedTitle) ??
    (aliasSeasons.size === 1 ? [...aliasSeasons][0] : null);
  const hasPrequel = related.items.some((item) =>
    item.relation?.toLowerCase() === 'prequel');
  const hasSequel = related.items.some((item) =>
    item.relation?.toLowerCase() === 'sequel');
  // Some indexers label a separately catalogued sequel S02 under the first
  // installment's name. Episode numbers alone must not cross that boundary.
  if (names.some((name) => releaseSeasons(name, [requestedTitle, ...requestedAliases]).some((season) =>
    (namedSeason !== null && season !== namedSeason) ||
    (namedSeason === null && season > 1 && !hasPrequel && hasSequel)))) {
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
