import path from 'node:path';
import { isCompleteAniDbDetail } from '../catalogue/hydration-ledger.mjs';
import { isOptionalClip, torrentFileKind } from './evaluate-stopped-manifest.mjs';

const held = (reason) => ({ state: 'held', reason });
const MAX_VIDEO_BYTES = 64 * 1024 ** 3;
const titleTokens = (value) => typeof value === 'string'
  ? (value.normalize('NFKC').toLocaleLowerCase('en')
    .replace(/&/g, ' and ').replace(/×/g, ' x ')
    .match(/[\p{L}\p{N}]+/gu) ?? []).flatMap((token, index, all) => {
      if (token === 'season' && /^0*[1-9]\d*$/.test(all[index + 1] ?? '')) return [];
      const season = /^s0*([1-9]\d*)$/.exec(token);
      return [season ? season[1] : token];
    }) : [];
// A search hit may be unrelated despite matching episode numbers. This is
// provisional title evidence; completed bytes still need exact AniDB proof.
export const matchesTrustedReleaseTitle = (releaseTitle, ...titles) => {
  // The first bracket in a torrent name normally identifies its release
  // group. It must not establish the anime identity by itself.
  const withoutGroup = typeof releaseTitle === 'string' ?
    releaseTitle.replace(/^\s*\[[^\]\r\n]{1,120}\]\s*(?=\S)/u, '') : releaseTitle;
  const release = titleTokens(withoutGroup);
  return titles.some((title) => {
    const key = titleTokens(title);
    const compact = key.join('');
    if (compact.length < 2) return false;
    if (release.includes(compact)) return true;
    return release.some((_, index) => key.every((word, offset) =>
      release[index + offset] === word));
  });
};

function episodeNumbers(name) {
  const stem = path.posix.basename(name, path.posix.extname(name));
  if (/(?<!\d)\d{1,4}\s*(?:\+|&|\band\b)\s*\d{1,4}(?!\d)/iu.test(stem)) return null;
  const matches = [];
  const plainRegular = /^(0*[1-9]\d*)$/.exec(stem);
  const plainPair = /^(0*[1-9]\d*)-(0*[1-9]\d*)$/.exec(stem);
  const plainSpecial = /^[Ss](0*[1-9]\d*)$/.exec(stem);
  const seasonEpisodes = [...stem.matchAll(
    /(?:^|[ ._-])[Ss](\d{1,3})[Ee](\d{1,4})(?:v\d{1,2})?(?=$|[ ._-])/gi)];
  // A second coordinate or a range must never be treated as one episode.
  if (seasonEpisodes.length > 1 ||
      (seasonEpisodes.length > 0 &&
        (/(?:^|[ ._-])[Ee]\d{1,4}(?=$|[ ._-])/i.test(stem) ||
          /[Ss]\d{1,3}[Ee]\d{1,4}-\d{1,4}/i.test(stem)))) return null;
  for (const match of seasonEpisodes) {
    const season = Number(match[1]);
    const episode = Number(match[2]);
    if (season > 99 || episode < 1) return null;
    matches.push({ type: season === 0 ? 'Special' : 'Episode',
      digits: match[2] });
  }
  for (const match of stem.matchAll(/(?:^|[ ._-])[Ee](0*[1-9]\d{0,3})(?:v\d{1,2})?(?=$|[ ._-])/gi)) {
    matches.push({ type: 'Episode', digits: match[1] });
  }
  if (plainRegular) matches.push({ type: 'Episode', digits: plainRegular[1] });
  if (plainPair) matches.push({ type: 'Episode', digits: plainPair[1], endDigits: plainPair[2] });
  if (plainSpecial) matches.push({ type: 'Special', digits: plainSpecial[1] });
  for (const match of stem.matchAll(/(?:^|\s)-\s+(0*[1-9]\d*)(?:v\d{1,2})?(?=\s|$)/gi)) {
    matches.push({ type: 'Episode', digits: match[1] });
  }
  for (const match of stem.matchAll(/(?:^|\s)-\s+(0*[1-9]\d*)-(0*[1-9]\d*)(?=\s|$)/g)) {
    matches.push({ type: 'Episode', digits: match[1], endDigits: match[2] });
  }
  for (const match of stem.matchAll(/(?:^|\s)-\s+[Ss](0*[1-9]\d*)(?=\s|$)/g)) {
    matches.push({ type: 'Special', digits: match[1] });
  }
  // Older DVD releases often put the episode immediately before a bracketed
  // source tag and CRC32, e.g. Show_01_[DVD][4BD6D6B5]. Do not treat a
  // bare underscore number or a release year as an episode coordinate.
  for (const match of stem.matchAll(/_(0*[1-9]\d{0,3})_(?=\[(?:DVD|BD|WEB|1080p|720p)\])/gi)) {
    matches.push({ type: 'Episode', digits: match[1] });
  }
  // Complete season packs also use a space before the source tag, e.g.
  // Show 01 [BD 1080p]. The source tag keeps a year in a title from becoming
  // episode evidence.
  for (const match of stem.matchAll(/(?:^|\s)(0*[1-9]\d{0,2})\s+(?=\[(?:DVD|BD|WEB|1080p|720p)\b)/gi)) {
    matches.push({ type: 'Episode', digits: match[1] });
  }
  if (matches.length === 0) {
    // A title-only one-off can be planned provisionally, but an explicit
    // episode coordinate in a format we do not parse must stay ambiguous.
    return /[Ss]\d{1,3}[Ee]\d{1,4}|(?:^|[ ._-])[Ee]\d{1,4}(?=$|[ ._-])/i.test(stem)
      ? null : { type: 'Unnumbered', numbers: [] };
  }
  const distinct = [...new Map(matches.map((match) => [
    `${match.type}:${match.digits}:${match.endDigits ?? ''}`, match,
  ])).values()];
  if (distinct.length !== 1 || !Number.isSafeInteger(Number(distinct[0].digits))) return null;
  const match = distinct[0];
  const start = Number(match.digits);
  if (!match.endDigits) return { type: match.type, numbers: [start] };
  const end = Number(match.endDigits);
  if (!Number.isSafeInteger(end) || end !== start + 1) return null;
  return { type: match.type, numbers: [start, end] };
}

// A complete pack can establish an episode coordinate from its file set.
// Constant title, season, year, and resolution numbers do not vary across
// files; the single position covering every requested regular number does.
// This is never used for one-file guesses or a partly numbered season.
function completePackNumbers(files, wantedNumbers, { allowAbsolute = false } = {}) {
  if (files.length < 2 || files.length !== wantedNumbers.size) return null;
  const tokens = files.map((file) => {
    // A bracketed hexadecimal checksum varies per file but is not episode
    // numbering. Keep short [01] coordinates and source tags in the scan.
    const stem = path.posix.basename(file.name, path.posix.extname(file.name))
      .replace(/\[[0-9a-f]{7,16}\]/giu, '');
    if (/(?<!\d)\d{1,4}\s*[-–]\s*\d{1,4}(?!\d)/u.test(stem)) return null;
    return [...stem.matchAll(/(?<!\d)0*([1-9]\d{0,3})(?!\d)/gu)]
      .map((match) => Number(match[1]));
  });
  if (tokens.some((row) => !row || row.length !== tokens[0].length)) return null;
  const varying = [];
  for (let index = 0; index < tokens[0].length; index++) {
    const numbers = tokens.map((row) => row[index]);
    if (new Set(numbers).size > 1) varying.push(numbers);
  }
  if (varying.length > 1) return { state: 'ambiguous' };
  if (varying.length !== 1 || new Set(varying[0]).size !== files.length) return null;
  const sourceNumbers = varying[0];
  if (sourceNumbers.every((number) => wantedNumbers.has(number))) {
    return { state: 'mapped', numbers: sourceNumbers };
  }
  if (!allowAbsolute) return null;
  const ordered = [...sourceNumbers].sort((a, b) => a - b);
  const wanted = [...wantedNumbers].sort((a, b) => a - b);
  // Only a full 1..N installment and a disjoint contiguous absolute run.
  // Never shift a subset, a partly overlapping run, or conflicting explicit
  // coordinates. This is provisional scope evidence, not file identity proof.
  if (!wanted.every((number, index) => number === index + 1) ||
      ordered[0] <= wanted.at(-1) ||
      !ordered.every((number, index) => number === ordered[0] + index) ||
      files.some((file, index) => {
        const parsed = episodeNumbers(file.name);
        return parsed?.type !== 'Episode' || parsed.numbers.length !== 1 ||
          parsed.numbers[0] !== sourceNumbers[index];
      })) return null;
  return { state: 'mapped', sourceNumbers,
    numbers: sourceNumbers.map((number) => number - ordered[0] + 1) };
}

// Provisional filename-to-AniDB episode mapping. A successful plan permits
// only a stopped candidate reservation; it never proves registered video bytes.
export function planTorrentTargets({ request, detail, prepared,
  releaseTitle, trustedTitle } = {}) {
  if (!Number.isSafeInteger(request?.id) || request.id < 1 ||
      request.status !== 'held' ||
      !['series', 'movie'].includes(request.kind) ||
      !isCompleteAniDbDetail(detail, request.anidbId) ||
      typeof detail.restricted !== 'boolean' ||
      detail.kind !== request.kind ||
      !Array.isArray(request.episodeIds) || request.episodeIds.length < 1 ||
      request.episodeIds.length > 2_000 ||
      request.episodeIds.some((id) => !Number.isSafeInteger(id) || id < 1) ||
      new Set(request.episodeIds).size !== request.episodeIds.length ||
      prepared?.state !== 'prepared_stopped' ||
      !Array.isArray(prepared.files) || prepared.files.length < 1 ||
      prepared.files.length > 500) return held('invalid_planning_evidence');
  const requested = new Set(request.episodeIds);
  const titleMatched = matchesTrustedReleaseTitle(releaseTitle,
    trustedTitle, detail.title);
  if ((trustedTitle !== undefined || releaseTitle !== undefined) &&
      !titleMatched) {
    return held('release_title_mismatch');
  }
  const regular = detail.episodes.filter((episode) => episode.type === 'Episode');
  const detailIds = new Set(detail.episodes.map((episode) => episode.id));
  if (request.episodeIds.some((id) => !detailIds.has(id))) return held('target_missing');

  const videos = [];
  const names = new Set();
  let totalBytes = 0;
  for (const file of prepared.files) {
    const kind = torrentFileKind(file?.name);
    if (!['video', 'subtitle', 'passive'].includes(kind) ||
        !Number.isSafeInteger(file.size) || file.size < 1 ||
        names.has(file.name.toLowerCase())) return held('unsafe_or_unselected_file');
    names.add(file.name.toLowerCase());
    if (kind === 'video') {
      totalBytes += file.size;
      videos.push(file);
    }
  }
  if (videos.length < 1 || videos.length > 50 ||
      !Number.isSafeInteger(totalBytes) || totalBytes > MAX_VIDEO_BYTES) {
    return held('video_budget_exceeded');
  }
  if (request.kind === 'movie') {
    if (videos.length !== 1 || request.episodeIds.length !== 1 ||
        !regular.some((episode) => episode.id === request.episodeIds[0])) {
      return held('ambiguous_movie_scope');
    }
    return { state: 'planned_targets', episodeIds: [...request.episodeIds],
      plannedFiles: [{ name: videos[0].name, size: videos[0].size,
        episodeIds: [...request.episodeIds] }] };
  }

  const hasRequestedSpecial = detail.episodes.some((episode) =>
    episode.type === 'Special' && requested.has(episode.id));
  const excludedVideoNames = hasRequestedSpecial ? [] : videos.filter((file) =>
    isOptionalClip(file.name)).map((file) => file.name);
  const targetVideos = videos.filter((file) => !excludedVideoNames.includes(file.name));

  const requestedRegularNumbers = new Set(detail.episodes.filter((episode) =>
    episode.type === 'Episode' && requested.has(episode.id))
    .map((episode) => episode.number));
  const needsSequence = targetVideos.some((file) => {
    const episode = episodeNumbers(file.name);
    return episode === null || episode.type === 'Unnumbered';
  });
  const allowAbsolute = titleMatched && regular.length === requestedRegularNumbers.size &&
    targetVideos.every((file) => {
      const parsed = episodeNumbers(file.name);
      return parsed?.type === 'Episode' && parsed.numbers.length === 1 &&
        !requestedRegularNumbers.has(parsed.numbers[0]);
    });
  const packSequence = hasRequestedSpecial || (!needsSequence && !allowAbsolute) ? null :
    completePackNumbers(targetVideos, requestedRegularNumbers, { allowAbsolute });
  if (packSequence?.state === 'ambiguous') return held('ambiguous_pack_numbering');

  const byNumber = new Map();
  for (const episode of detail.episodes.filter((item) =>
    item.type === 'Episode' || item.type === 'Special')) {
    if (!Number.isSafeInteger(episode.number) || episode.number < 1 ||
        byNumber.has(`${episode.type}:${episode.number}`)) {
      return held('ambiguous_catalogue_number');
    }
    byNumber.set(`${episode.type}:${episode.number}`, episode.id);
  }
  const plannedFiles = [];
  const targets = new Set();
  const trustedUnnumberedTitle = typeof trustedTitle === 'string' &&
    trustedTitle.length <= 120 && releaseTitle?.length <= 500 &&
    titleMatched;
  const soleUnnumberedTarget = targetVideos.length === 1 &&
    request.episodeIds.length === 1 && regular.length === 1 &&
    regular[0].id === request.episodeIds[0] && trustedUnnumberedTitle
    ? regular[0].id : null;
  for (const [index, file] of targetVideos.entries()) {
    const episode = episodeNumbers(file.name);
    const inferred = packSequence?.state === 'mapped' ? packSequence.numbers[index] : null;
    if (inferred !== null && episode === null) return held('ambiguous_pack_numbering');
    if (inferred !== null && episode?.type !== 'Unnumbered' &&
        (episode.type !== 'Episode' || episode.numbers.length !== 1 ||
          episode.numbers[0] !== (packSequence.sourceNumbers?.[index] ?? inferred))) {
      return held('ambiguous_pack_numbering');
    }
    const ids = inferred !== null ? [byNumber.get(`Episode:${inferred}`)] :
      episode?.type === 'Unnumbered' && soleUnnumberedTarget
      ? [soleUnnumberedTarget]
      : episode?.type === 'Unnumbered' ? null
        : episode?.numbers.map((number) => byNumber.get(`${episode.type}:${number}`));
    if (!ids || ids.length === 0 || ids.some((id) =>
      !id || !requested.has(id) || targets.has(id))) {
      return held('ambiguous_or_unrequested_video');
    }
    for (const id of ids) targets.add(id);
    plannedFiles.push({ name: file.name, size: file.size, episodeIds: ids });
  }
  if (plannedFiles.length === 0) return held('no_requested_video');
  return { state: 'planned_targets',
    episodeIds: [...targets].sort((a, b) => a - b), plannedFiles,
    ...(packSequence?.sourceNumbers?{numberingEvidence:'complete_absolute_sequence'}:{}),
    ...(excludedVideoNames.length ? { excludedVideoNames } : {}) };
}
