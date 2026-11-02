import path from 'node:path';
import { isCompleteAniDbDetail } from '../catalogue/hydration-ledger.mjs';
import { torrentFileKind } from './evaluate-stopped-manifest.mjs';

const held = (reason) => ({ state: 'held', reason });
const MAX_VIDEO_BYTES = 64 * 1024 ** 3;

function episodeNumbers(name) {
  const stem = path.posix.basename(name, path.posix.extname(name));
  const matches = [];
  const plainRegular = /^(0*[1-9]\d*)$/.exec(stem);
  const plainPair = /^(0*[1-9]\d*)-(0*[1-9]\d*)$/.exec(stem);
  const plainSpecial = /^[Ss](0*[1-9]\d*)$/.exec(stem);
  if (plainRegular) matches.push({ type: 'Episode', digits: plainRegular[1] });
  if (plainPair) matches.push({ type: 'Episode', digits: plainPair[1], endDigits: plainPair[2] });
  if (plainSpecial) matches.push({ type: 'Special', digits: plainSpecial[1] });
  for (const match of stem.matchAll(/(?:^|\s)-\s+(0*[1-9]\d*)(?=\s|$)/g)) {
    matches.push({ type: 'Episode', digits: match[1] });
  }
  for (const match of stem.matchAll(/(?:^|\s)-\s+(0*[1-9]\d*)-(0*[1-9]\d*)(?=\s|$)/g)) {
    matches.push({ type: 'Episode', digits: match[1], endDigits: match[2] });
  }
  for (const match of stem.matchAll(/(?:^|\s)-\s+[Ss](0*[1-9]\d*)(?=\s|$)/g)) {
    matches.push({ type: 'Special', digits: match[1] });
  }
  if (matches.length === 0) {
    // A title-only one-off can be planned provisionally, but an explicit
    // episode coordinate in a format we do not parse must stay ambiguous.
    return /(?:^|[ ._-])(?:[Ss]\d{1,3}[Ee]\d{1,4}|[Ee]\d{1,4})(?=$|[ ._-])/i.test(stem)
      ? null : { type: 'Unnumbered', numbers: [] };
  }
  if (matches.length !== 1 || !Number.isSafeInteger(Number(matches[0].digits))) return null;
  const match = matches[0];
  const start = Number(match.digits);
  if (!match.endDigits) return { type: match.type, numbers: [start] };
  const end = Number(match.endDigits);
  if (!Number.isSafeInteger(end) || end !== start + 1) return null;
  return { type: match.type, numbers: [start, end] };
}

// Provisional filename-to-AniDB episode mapping. A successful plan permits
// only a stopped candidate reservation; it never proves registered video bytes.
export function planTorrentTargets({ request, detail, prepared,
  releaseTitle, trustedTitle } = {}) {
  if (!Number.isSafeInteger(request?.id) || request.id < 1 ||
      request.status !== 'held' ||
      !['series', 'movie'].includes(request.kind) ||
      !isCompleteAniDbDetail(detail, request.anidbId) ||
      detail.restricted !== false ||
      detail.kind !== request.kind ||
      !Array.isArray(request.episodeIds) || request.episodeIds.length < 1 ||
      request.episodeIds.length > 2_000 ||
      request.episodeIds.some((id) => !Number.isSafeInteger(id) || id < 1) ||
      new Set(request.episodeIds).size !== request.episodeIds.length ||
      prepared?.state !== 'prepared_stopped' ||
      !Array.isArray(prepared.files) || prepared.files.length < 1 ||
      prepared.files.length > 500) return held('invalid_planning_evidence');
  const requested = new Set(request.episodeIds);
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
    trustedTitle.trim().length >= 2 && trustedTitle.length <= 120 &&
    typeof releaseTitle === 'string' && releaseTitle.length <= 500 &&
    releaseTitle.toLocaleLowerCase('en').includes(
      trustedTitle.trim().toLocaleLowerCase('en'));
  const soleUnnumberedTarget = videos.length === 1 &&
    request.episodeIds.length === 1 && regular.length === 1 &&
    regular[0].id === request.episodeIds[0] && trustedUnnumberedTitle
    ? regular[0].id : null;
  for (const file of videos) {
    const episode = episodeNumbers(file.name);
    const ids = episode?.type === 'Unnumbered' && soleUnnumberedTarget
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
  return { state: 'planned_targets',
    episodeIds: [...targets].sort((a, b) => a - b), plannedFiles };
}
