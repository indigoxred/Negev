import path from 'node:path';
import { isCompleteAniDbDetail } from '../catalogue/hydration-ledger.mjs';
import { torrentFileKind } from './evaluate-stopped-manifest.mjs';

const held = (reason) => ({ state: 'held', reason });
const MAX_VIDEO_BYTES = 64 * 1024 ** 3;

function episodeNumber(name) {
  const stem = path.posix.basename(name, path.posix.extname(name));
  const plain = /^(?:0*[1-9]\d{0,2})$/.exec(stem);
  if (plain) return Number(stem);
  const matches = [...stem.matchAll(/(?:^|\s)-\s+(0*[1-9]\d{0,2})(?=\s|$)/g)];
  return matches.length === 1 ? Number(matches[0][1]) : null;
}

// Provisional filename-to-AniDB episode mapping. A successful plan permits
// only a stopped candidate reservation; it never proves registered video bytes.
export function planTorrentTargets({ request, detail, prepared } = {}) {
  if (!Number.isSafeInteger(request?.id) || request.id < 1 ||
      request.status !== 'held' ||
      !['series', 'movie'].includes(request.kind) ||
      !isCompleteAniDbDetail(detail, request.anidbId) ||
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
    if (!['video', 'subtitle'].includes(kind) ||
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
  for (const episode of regular) {
    if (!Number.isSafeInteger(episode.number) || episode.number < 1 ||
        byNumber.has(episode.number)) return held('ambiguous_catalogue_number');
    byNumber.set(episode.number, episode.id);
  }
  const plannedFiles = [];
  const targets = new Set();
  for (const file of videos) {
    const number = episodeNumber(file.name);
    const id = byNumber.get(number);
    if (!id || !requested.has(id) || targets.has(id)) {
      return held('ambiguous_or_unrequested_video');
    }
    targets.add(id);
    plannedFiles.push({ name: file.name, size: file.size, episodeIds: [id] });
  }
  return { state: 'planned_targets',
    episodeIds: [...targets].sort((a, b) => a - b), plannedFiles };
}
