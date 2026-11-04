import { collectAniDbDetail } from '../catalogue/collect-detail.mjs';
import { prepareStoppedCandidate } from './prepare-stopped-candidate.mjs';
import { planTorrentTargets } from './plan-torrent-targets.mjs';
import { torrentFileKind } from './evaluate-stopped-manifest.mjs';
import { trustedReleaseQueries } from './trusted-release-queries.mjs';
import { MAX_RELEASE_GUID_LENGTH } from './release-candidate-limits.mjs';
import { checkRelatedInstallment } from './related-installment-guard.mjs';

const held = (reason) => ({ state: 'held', reason });
const validId = (value) => Number.isSafeInteger(value) && value > 0;

// Read-only review of one saved request and one exact Prowlarr candidate.
// This never sends the prepared FormData to qBittorrent and does not claim
// that the future downloaded bytes are registered with AniDB.
export async function previewRequestCandidate({ requestId, candidate,
  readRequest, loadDetail, releaseQueries = async () => [],
  readRelatedTitles,
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  prepare = prepareStoppedCandidate } = {}) {
  if (!validId(requestId) || typeof readRequest !== 'function' ||
      typeof loadDetail !== 'function' || typeof prepare !== 'function' ||
      typeof releaseQueries !== 'function' || typeof pause !== 'function' ||
      (readRelatedTitles !== undefined && typeof readRelatedTitles !== 'function') ||
      typeof candidate?.guid !== 'string' || !candidate.guid ||
      candidate.guid.length > MAX_RELEASE_GUID_LENGTH || !validId(candidate.indexerId) ||
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
      detail.restricted !== false) {
    return held('detail_unavailable');
  }
  const knownTargets = new Set(detail.episodes.map((episode) => episode.id));
  if (request.episodeIds.some((id) => !knownTargets.has(id))) {
    return held('target_missing');
  }
  const canonicalQuery = trustedReleaseQueries(detail.title)[0];
  let aliases = [];
  if (!canonicalQuery) {
    try { aliases = await releaseQueries({ anidbId: request.anidbId }); }
    catch { return held('trusted_query_unavailable'); }
  }
  const firstQuery = trustedReleaseQueries(detail.title, aliases)[0];
  if (!firstQuery) return held('detail_unavailable');
  let prepared;
  let searchQuery = firstQuery;
  try { prepared = await prepare({ query: firstQuery, candidate }); }
  catch { return held('torrent_preflight_unavailable'); }
  if (prepared?.state === 'held' && prepared.reason === 'candidate_changed') {
    if (canonicalQuery) {
      try { aliases = await releaseQueries({ anidbId: request.anidbId }); }
      catch { aliases = []; }
    }
    const queries = trustedReleaseQueries(detail.title, aliases);
    for (const query of queries.filter((value) => value !== firstQuery)) {
      try { await pause(1_000); }
      catch { return held('torrent_preflight_unavailable'); }
      try { prepared = await prepare({ query, candidate }); }
      catch { return held('torrent_preflight_unavailable'); }
      if (prepared?.state === 'prepared_stopped') {
        searchQuery = query;
        break;
      }
      if (prepared?.reason !== 'candidate_changed') break;
    }
  }
  if (prepared?.state !== 'prepared_stopped') {
    return held(prepared?.reason ?? 'torrent_preflight_unavailable');
  }
  if (readRelatedTitles) {
    let related;
    try { related = await readRelatedTitles({ anidbId: request.anidbId }); }
    catch { return held('related_title_unavailable'); }
    const checked = checkRelatedInstallment({ anidbId: request.anidbId,
      requestedTitle: detail.title, related, releaseTitle: candidate.title,
      fileNames: prepared.files.filter((file) =>
        torrentFileKind(file.name) === 'video').map((file) => file.name) });
    if (checked.state !== 'related_title_clear') return checked;
  }
  const plan = planTorrentTargets({ request, detail, prepared,
    releaseTitle: candidate.title, trustedTitle: searchQuery });
  if (plan.state !== 'planned_targets') return plan;
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(prepared.expected?.hash) ||
      !Number.isSafeInteger(prepared.totalBytes) || prepared.totalBytes < 1 ||
      !['v1', 'v2', 'hybrid'].includes(prepared.version)) {
    return held('invalid_metainfo');
  }
  return { state: 'preflight', requestId, anidbId: request.anidbId,
    ...(searchQuery === canonicalQuery ? {} : { searchQuery }),
    torrentHash: prepared.expected.hash.toLowerCase(),
    version: prepared.version, totalBytes: prepared.totalBytes,
    episodeIds: plan.episodeIds, files: plan.plannedFiles,
    subtitles: prepared.files.filter((file) =>
      torrentFileKind(file.name) === 'subtitle').map((file) => ({
      name: file.name, size: file.size })),
    filesToExclude: prepared.files.filter((file) =>
      torrentFileKind(file.name) === 'passive').map((file) => ({
      name: file.name, size: file.size })),
    registeredInAniDb: false, downloadStarted: false };
}
