import { collectAniDbDetail } from '../catalogue/collect-detail.mjs';
import { prepareStoppedCandidate } from './prepare-stopped-candidate.mjs';
import { matchesTrustedReleaseTitle, planTorrentTargets } from './plan-torrent-targets.mjs';
import { torrentFileKind } from './evaluate-stopped-manifest.mjs';
import { trustedReleaseQueries, trustedTargetedQuery } from './trusted-release-queries.mjs';
import { MAX_RELEASE_GUID_LENGTH } from './release-candidate-limits.mjs';
import { checkRelatedInstallment } from './related-installment-guard.mjs';
import { acceptsShokoVideo } from './shoko-video-extensions.mjs';
import { evaluateOfflinePreview } from '../identity/evaluate-offline-preview.mjs';
import { basename } from 'node:path';

const held = (reason) => ({ state: 'held', reason });
const validId = (value) => Number.isSafeInteger(value) && value > 0;

// Read-only review of one saved request and one exact Prowlarr candidate.
// This never sends the prepared FormData to qBittorrent and does not claim
// that the future downloaded bytes are registered with AniDB.
export async function previewRequestCandidate({ requestId, candidate,
  readRequest, loadDetail, releaseQueries = async () => [],
  readRelatedTitles,
  readVideoExtensions, offlineLookup, offlineCache,
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  prepare = prepareStoppedCandidate } = {}) {
  if (!validId(requestId) || typeof readRequest !== 'function' ||
      typeof loadDetail !== 'function' || typeof prepare !== 'function' ||
      typeof releaseQueries !== 'function' || typeof pause !== 'function' ||
      (readRelatedTitles !== undefined && typeof readRelatedTitles !== 'function') ||
      (readVideoExtensions !== undefined && typeof readVideoExtensions !== 'function') ||
      (offlineLookup !== undefined && typeof offlineLookup !== 'function') ||
      (offlineCache !== undefined && !(offlineCache instanceof Map)) ||
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
      typeof detail.restricted !== 'boolean') {
    return held('detail_unavailable');
  }
  const knownTargets = new Set(detail.episodes.map((episode) => episode.id));
  if (request.episodeIds.some((id) => !knownTargets.has(id))) {
    return held('target_missing');
  }
  let aliases = [];
  try { aliases = await releaseQueries({ anidbId: request.anidbId }); }
  catch { /* The canonical title can still be used. */ }
  const queries = trustedReleaseQueries(detail.title, aliases);
  const canonicalQuery = trustedReleaseQueries(detail.title)[0];
  const firstQuery = queries.find((query) =>
    matchesTrustedReleaseTitle(candidate.title, query)) ?? canonicalQuery;
  if (!firstQuery) return held('detail_unavailable');
  let sourceQuery = firstQuery;
  if (candidate.sourceQuery !== undefined) {
    if (typeof candidate.sourceQuery !== 'string' ||
        /[\x00-\x1f\x7f]/.test(candidate.sourceQuery)) {
      return held('untrusted_release_query');
    }
    if (candidate.targetEpisodeId !== undefined) {
      const target = detail.episodes.find((episode) =>
        episode.id === candidate.targetEpisodeId && episode.type === 'Episode');
      if (!target || !request.episodeIds.includes(target.id) ||
          candidate.sourceQuery !== trustedTargetedQuery(detail.title,
            aliases, target.number)) return held('untrusted_release_query');
    } else if (!queries.includes(candidate.sourceQuery)) {
      return held('untrusted_release_query');
    }
    sourceQuery = candidate.sourceQuery;
  }
  let prepared;
  let searchQuery = sourceQuery;
  try { prepared = await prepare({ query: sourceQuery, candidate }); }
  catch { return held('torrent_preflight_unavailable'); }
  if (prepared?.state === 'held' && prepared.reason === 'candidate_changed') {
    for (const query of queries.filter((value) => value !== sourceQuery)) {
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
    releaseTitle: candidate.title, trustedTitle: firstQuery });
  if (plan.state !== 'planned_targets') return plan;
  if (candidate.targetEpisodeId !== undefined &&
      !plan.episodeIds.includes(candidate.targetEpisodeId)) {
    return held('targeted_result_wrong_episode');
  }
  if (readVideoExtensions) {
    let extensions;
    try { extensions = await readVideoExtensions(); }
    catch { return held('shoko_settings_unavailable'); }
    if (extensions?.state !== 'extensions') return held('shoko_settings_unavailable');
    if (plan.plannedFiles.some((file) =>
      !acceptsShokoVideo(file.name, extensions))) {
      return held('shoko_video_format_unsupported');
    }
  }
  let shokoPreview;
  if (offlineLookup) {
    const verdicts = [];
    for (const file of plan.plannedFiles) {
      const filename = basename(file.name);
      if (!Array.isArray(file.episodeIds) || file.episodeIds.length !== 1 ||
          filename.length > 255) {
        verdicts.push('uncertain');
        continue;
      }
      let result = offlineCache?.get(filename);
      if (!result) {
        try { result = await offlineLookup({ filename }); }
        catch { result = { status: 0 }; }
        offlineCache?.set(filename, result);
      }
      const verdict = evaluateOfflinePreview(result, {
        animeId: request.anidbId, episodeIds: file.episodeIds, filename });
      if (verdict.state === 'rejected') {
        return held('shoko_preview_wrong_identity');
      }
      verdicts.push(verdict.state === 'accepted' ? 'exact' : 'uncertain');
    }
    shokoPreview = verdicts.every((value) => value === 'exact')
      ? 'exact' : 'uncertain';
  }
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(prepared.expected?.hash) ||
      !Number.isSafeInteger(prepared.totalBytes) || prepared.totalBytes < 1 ||
      !['v1', 'v2', 'hybrid'].includes(prepared.version)) {
    return held('invalid_metainfo');
  }
  return { state: 'preflight', requestId, anidbId: request.anidbId,
    ...(searchQuery === canonicalQuery ? {} : { searchQuery }),
    torrentHash: prepared.expected.hash.toLowerCase(),
    ...(shokoPreview ? { shokoPreview } : {}),
    version: prepared.version, totalBytes: prepared.totalBytes,
    episodeIds: plan.episodeIds, files: plan.plannedFiles,
    subtitles: prepared.files.filter((file) =>
      torrentFileKind(file.name) === 'subtitle').map((file) => ({
      name: file.name, size: file.size })),
    filesToExclude: prepared.files.filter((file) =>
      torrentFileKind(file.name) === 'passive' ||
      plan.excludedVideoNames?.includes(file.name)).map((file) => ({
      name: file.name, size: file.size })),
    registeredInAniDb: false, downloadStarted: false };
}
