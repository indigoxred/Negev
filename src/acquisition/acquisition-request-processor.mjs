import { isCompleteAniDbDetail } from '../catalogue/hydration-ledger.mjs';
import { planTorrentTargets } from './plan-torrent-targets.mjs';

const held = (reason) => ({ state: 'held', reason });
const validId = (value) => Number.isSafeInteger(value) && value > 0;
const validReason = (value) => typeof value === 'string' &&
  /^[a-z][a-z0-9_]{0,79}$/.test(value);

// One request, at most a few read-only candidate inspections, and at most one
// stopped submission. The submit callback must be the guarded coordinator;
// this processor cannot authorize absence or start the resulting torrent.
export function createAcquisitionRequestProcessor({ readRequest,
  discoverCandidates, previewCandidate, loadDetail, submitCandidate,
  maxPreflights = 3 } = {}) {
  if ([readRequest, discoverCandidates, previewCandidate, loadDetail,
    submitCandidate].some((fn) => typeof fn !== 'function') ||
      !Number.isSafeInteger(maxPreflights) || maxPreflights < 1 ||
      maxPreflights > 5) throw new TypeError('Invalid acquisition processor');
  return async ({ requestId, candidateOffset = 0 } = {}) => {
    if (!validId(requestId) || !Number.isSafeInteger(candidateOffset) ||
        candidateOffset < 0 || candidateOffset > 50) return held('invalid_request');
    let request;
    try { request = await readRequest(requestId); }
    catch { return held('request_unavailable'); }
    if (request?.id !== requestId || request.status !== 'held' ||
        !validId(request.anidbId) ||
        !['series', 'movie'].includes(request.kind) ||
        !Array.isArray(request.episodeIds) || request.episodeIds.length < 1 ||
        request.episodeIds.length > 2_000 ||
        request.episodeIds.some((id) => !validId(id)) ||
        new Set(request.episodeIds).size !== request.episodeIds.length) {
      return held('request_unavailable');
    }
    let found;
    try { found = await discoverCandidates({ requestId }); }
    catch { return held('release_search_unavailable'); }
    if (found?.state !== 'candidates') {
      return held(validReason(found?.reason) ? found.reason :
        'release_search_unavailable');
    }
    if (found.requestId !== requestId || found.anidbId !== request.anidbId ||
        !Array.isArray(found.items) || found.items.length > 50 ||
        found.items.some((candidate) => !validId(candidate?.indexerId) ||
          typeof candidate.guid !== 'string' || !candidate.guid ||
          candidate.guid.length > 500 || candidate.evidence !== 'unverified')) {
      return held('release_search_unavailable');
    }
    if (found.items.length === 0) return { ...held('no_release_candidates'),
      nextCandidateOffset: 0 };
    const seen = new Set();
    let selected;
    const start = candidateOffset < found.items.length ? candidateOffset : 0;
    let nextIndex = start;
    for (let index = start; index < found.items.length; index++) {
      if (seen.size >= maxPreflights) break;
      nextIndex = index + 1;
      const candidate = found.items[index];
      const key = `${candidate.indexerId}:${candidate.guid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let preview;
      try { preview = await previewCandidate({ requestId, candidate }); }
      catch { continue; }
      if (preview?.state !== 'preflight' ||
          preview.requestId !== requestId ||
          preview.anidbId !== request.anidbId ||
          typeof preview.torrentHash !== 'string' ||
          !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(preview.torrentHash) ||
          !Array.isArray(preview.episodeIds) ||
          preview.episodeIds.length < 1 || preview.episodeIds.length > 50 ||
          new Set(preview.episodeIds).size !== preview.episodeIds.length ||
          preview.episodeIds.some((id) => !request.episodeIds.includes(id)) ||
          !Array.isArray(preview.files) || preview.files.length < 1 ||
          preview.files.length > 50) continue;
      selected = { candidate, preview };
      break;
    }
    if (!selected) return { ...held('no_safe_release'),
      nextCandidateOffset: nextIndex < found.items.length ? nextIndex : 0 };
    let detail;
    try { detail = await loadDetail({ anidbId: request.anidbId }); }
    catch { return held('detail_unavailable'); }
    if (!isCompleteAniDbDetail(detail, request.anidbId) ||
        detail.kind !== request.kind || detail.restricted !== false) {
      return held('detail_unavailable');
    }
    const currentIds = new Set(detail.episodes.map((episode) => episode.id));
    if (request.episodeIds.some((id) => !currentIds.has(id))) {
      return held('target_missing');
    }
    const freshPlan = planTorrentTargets({ request, detail,
      prepared: { state: 'prepared_stopped', files: selected.preview.files } });
    if (freshPlan.state !== 'planned_targets' ||
        JSON.stringify(freshPlan.episodeIds) !==
          JSON.stringify(selected.preview.episodeIds) ||
        JSON.stringify(freshPlan.plannedFiles) !==
          JSON.stringify(selected.preview.files)) {
      return held('preflight_mapping_changed');
    }
    let outcome;
    try { outcome = await submitCandidate({ request,
      candidate: selected.candidate, detail,
      episodeIds: [...selected.preview.episodeIds],
      plannedFiles: selected.preview.files,
      expectedHash: selected.preview.torrentHash.toLowerCase() }); }
    catch { return held('submit_unavailable'); }
    if (outcome?.state === 'stopped_observed' && validId(outcome.attemptId)) {
      return { state: 'stopped_observed', attemptId: outcome.attemptId };
    }
    // This result is issued before any reservation or torrent dispatch. A
    // later candidate may cover another requested episode that is still
    // missing. All uncertain outcomes retry the same selected candidate.
    if (outcome?.state === 'held' && outcome.reason === 'target_already_available') {
      return { ...held('target_already_available'),
        nextCandidateOffset: nextIndex < found.items.length ? nextIndex : 0 };
    }
    return held(validReason(outcome?.reason) ? outcome.reason :
      'submit_unavailable');
  };
}
