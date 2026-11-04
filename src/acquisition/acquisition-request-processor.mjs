import { isCompleteAniDbDetail } from '../catalogue/hydration-ledger.mjs';
import { planTorrentTargets } from './plan-torrent-targets.mjs';
import { createHash } from 'node:crypto';
import { MAX_RELEASE_GUID_LENGTH } from './release-candidate-limits.mjs';

const held = (reason) => ({ state: 'held', reason });
const validId = (value) => Number.isSafeInteger(value) && value > 0;
const validReason = (value) => typeof value === 'string' &&
  /^[a-z][a-z0-9_]{0,79}$/.test(value);

// One request, at most a few read-only candidate inspections, and at most one
// stopped submission. The submit callback must be the guarded coordinator;
// this processor cannot authorize absence or start the resulting torrent.
export function createAcquisitionRequestProcessor({ readRequest,
  discoverCandidates, previewCandidate, loadDetail, submitCandidate,
  readPublicCoverage,
  maxPreflights = 3 } = {}) {
  if ([readRequest, discoverCandidates, previewCandidate, loadDetail,
    submitCandidate].some((fn) => typeof fn !== 'function') ||
      (readPublicCoverage !== undefined && typeof readPublicCoverage !== 'function') ||
      !Number.isSafeInteger(maxPreflights) || maxPreflights < 1 ||
      maxPreflights > 5) throw new TypeError('Invalid acquisition processor');
  return async ({ requestId, candidateOffset = 0,
    candidateFingerprint = null } = {}) => {
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
    let exactAvailable = new Set();
    if (readPublicCoverage) {
      let coverage;
      try { coverage = await readPublicCoverage(request); }
      catch { return held('availability_unverified'); }
      if (!Number.isSafeInteger(coverage?.verifiedTargets) ||
          coverage.verifiedTargets < 0 ||
          coverage.verifiedTargets > request.episodeIds.length ||
          coverage.targetCount !== request.episodeIds.length) {
        return held('availability_unverified');
      }
      if (coverage.availableEpisodeIds !== undefined) {
        const ids = coverage.availableEpisodeIds;
        if (!Array.isArray(ids) || ids.length !== coverage.verifiedTargets ||
            new Set(ids).size !== ids.length ||
            ids.some((id) => !request.episodeIds.includes(id))) {
          return held('availability_unverified');
        }
        exactAvailable = new Set(ids);
      }
      if (coverage.verifiedTargets === request.episodeIds.length) {
        return { ...held('request_fully_available'), nextCandidateOffset: 0 };
      }
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
          candidate.guid.length > MAX_RELEASE_GUID_LENGTH || candidate.evidence !== 'unverified')) {
      return held('release_search_unavailable');
    }
    if (found.items.length === 0) return { ...held('no_release_candidates'),
      nextCandidateOffset: 0 };
    // Prefer a release with peers, while retaining provider order for ties.
    // The exact AniDB and file checks below still decide whether it is safe.
    const candidates = [...new Map(found.items.map((item) =>
      [`${item.indexerId}:${item.guid}`, item])).values()].sort((a, b) => {
      const peers = (item) => Number.isSafeInteger(item.seeders) &&
        item.seeders >= 0 ? item.seeders : -1;
      return peers(b) - peers(a);
    });
    const candidateId = (item) => createHash('sha256').update(
      JSON.stringify([item.indexerId, item.guid])).digest('hex');
    const currentById = new Map(candidates.map((item) =>
      [candidateId(item), item]));
    // A new target or changed candidate set starts a fresh sweep. Seeder
    // changes alone must retain the original order until that sweep ends.
    const fingerprint = createHash('sha256').update(JSON.stringify({
      episodeIds: [...request.episodeIds].sort((a, b) => a - b),
      candidates: [...currentById.keys()].sort(),
    })).digest('hex');
    const saved = typeof candidateFingerprint === 'string' &&
      candidateFingerprint.length <= 3_400 ? candidateFingerprint.split(':') : [];
    const savedOrder = saved.length === 2 && saved[0] === fingerprint ?
      saved[1].split(',') : [];
    const sameSet = savedOrder.length === currentById.size &&
      new Set(savedOrder).size === savedOrder.length &&
      savedOrder.every((id) => /^[0-9a-f]{64}$/.test(id) && currentById.has(id));
    const ordered = sameSet ? savedOrder.map((id) => currentById.get(id)) : candidates;
    const cursor = `${fingerprint}:${ordered.map(candidateId).join(',')}`;
    const seen = new Set();
    let selected;
    const start = sameSet && candidateOffset < ordered.length ?
      candidateOffset : 0;
    let nextIndex = start;
    for (let index = start; index < ordered.length; index++) {
      if (seen.size >= maxPreflights) break;
      nextIndex = index + 1;
      const candidate = ordered[index];
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
          (preview.searchQuery !== undefined &&
            (typeof preview.searchQuery !== 'string' ||
              preview.searchQuery.length < 2 || preview.searchQuery.length > 120 ||
              /[\x00-\x1f\x7f]/.test(preview.searchQuery))) ||
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
      nextCandidateOffset: nextIndex < ordered.length ? nextIndex : 0,
      nextCandidateFingerprint: cursor };
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
      prepared: { state: 'prepared_stopped', files: selected.preview.files },
      releaseTitle: selected.candidate.title,
      trustedTitle: selected.preview.searchQuery ?? detail.title });
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
      expectedHash: selected.preview.torrentHash.toLowerCase(),
      ...(selected.preview.searchQuery === undefined ? {} :
        { searchQuery: selected.preview.searchQuery }) }); }
    catch { return held('submit_unavailable'); }
    if (outcome?.state === 'stopped_observed' && validId(outcome.attemptId)) {
      return { state: 'stopped_observed', attemptId: outcome.attemptId };
    }
    // This result is issued before any reservation or torrent dispatch. A
    // later candidate may cover another requested episode that is still
    // missing. A Shoko hold advances only for the exact target with current
    // public Plex proof; provider-wide uncertainty retries this candidate.
    if (outcome?.state === 'held' &&
        (outcome.reason === 'target_already_available' ||
          (outcome.reason === 'target_not_proven_unimported' &&
            selected.preview.episodeIds.includes(outcome.episodeId) &&
            exactAvailable.has(outcome.episodeId)) ||
          outcome.reason === 'candidate_rejected' ||
          outcome.reason === 'candidate_retired' ||
          outcome.reason === 'candidate_released' ||
          outcome.reason === 'target_not_proven_missing' &&
          selected.preview.episodeIds.includes(outcome.episodeId))) {
      return { ...held(outcome.reason),
        nextCandidateOffset: nextIndex < ordered.length ? nextIndex : 0,
        nextCandidateFingerprint: cursor };
    }
    return held(validReason(outcome?.reason) ? outcome.reason :
      'submit_unavailable');
  };
}
