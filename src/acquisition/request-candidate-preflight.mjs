import { collectAniDbDetail } from '../catalogue/collect-detail.mjs';
import { prepareStoppedCandidate } from './prepare-stopped-candidate.mjs';
import { planTorrentTargets } from './plan-torrent-targets.mjs';

const held = (reason) => ({ state: 'held', reason });
const validId = (value) => Number.isSafeInteger(value) && value > 0;

// Read-only review of one saved request and one exact Prowlarr candidate.
// This never sends the prepared FormData to qBittorrent and does not claim
// that the future downloaded bytes are registered with AniDB.
export async function previewRequestCandidate({ requestId, candidate,
  readRequest, loadDetail, prepare = prepareStoppedCandidate } = {}) {
  if (!validId(requestId) || typeof readRequest !== 'function' ||
      typeof loadDetail !== 'function' || typeof prepare !== 'function' ||
      typeof candidate?.guid !== 'string' || !candidate.guid ||
      candidate.guid.length > 500 || !validId(candidate.indexerId) ||
      typeof candidate.title !== 'string' || !candidate.title.trim() ||
      candidate.title.length > 500 || !Number.isSafeInteger(candidate.size) ||
      candidate.size < 1) return held('invalid_preflight');
  let request;
  try { request = await readRequest(requestId); }
  catch { return held('request_unavailable'); }
  if (request?.id !== requestId || request.status !== 'held' ||
      !validId(request.anidbId) || !['series', 'movie'].includes(request.kind) ||
      !Array.isArray(request.episodeIds) || request.episodeIds.length < 1 ||
      request.episodeIds.some((id) => !validId(id))) return held('request_missing');
  let detail;
  try { detail = await collectAniDbDetail({ anidbId: request.anidbId,
    loadPage: loadDetail }); }
  catch { return held('detail_unavailable'); }
  if (detail.state !== 'details' || detail.kind !== request.kind ||
      detail.restricted !== false || detail.title.length > 120) {
    return held('detail_unavailable');
  }
  const knownTargets = new Set(detail.episodes.map((episode) => episode.id));
  if (request.episodeIds.some((id) => !knownTargets.has(id))) {
    return held('target_missing');
  }
  let prepared;
  try { prepared = await prepare({ query: detail.title, candidate }); }
  catch { return held('torrent_preflight_unavailable'); }
  if (prepared?.state !== 'prepared_stopped') {
    return held(prepared?.reason ?? 'torrent_preflight_unavailable');
  }
  const plan = planTorrentTargets({ request, detail, prepared });
  if (plan.state !== 'planned_targets') return plan;
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(prepared.expected?.hash) ||
      !Number.isSafeInteger(prepared.totalBytes) || prepared.totalBytes < 1 ||
      !['v1', 'v2', 'hybrid'].includes(prepared.version)) {
    return held('invalid_metainfo');
  }
  return { state: 'preflight', requestId, anidbId: request.anidbId,
    torrentHash: prepared.expected.hash.toLowerCase(),
    version: prepared.version, totalBytes: prepared.totalBytes,
    episodeIds: plan.episodeIds, files: plan.plannedFiles,
    registeredInAniDb: false, downloadStarted: false };
}
