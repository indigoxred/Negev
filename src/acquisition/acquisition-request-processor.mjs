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
  readPublicCoverage, inspectCandidateTargets,
  maxPreflights = 3 } = {}) {
  if ([readRequest, discoverCandidates, previewCandidate, loadDetail,
    submitCandidate].some((fn) => typeof fn !== 'function') ||
      (readPublicCoverage !== undefined && typeof readPublicCoverage !== 'function') ||
      (inspectCandidateTargets !== undefined &&
        typeof inspectCandidateTargets !== 'function') ||
      !Number.isSafeInteger(maxPreflights) || maxPreflights < 1 ||
      maxPreflights > 5) throw new TypeError('Invalid acquisition processor');
  return async ({ requestId, pass = 1, candidateOffset = 0,
    candidateFingerprint = null } = {}) => {
    if (!validId(requestId) || !validId(pass) ||
        !Number.isSafeInteger(candidateOffset) ||
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
    const missingIds = request.episodeIds.filter((id) => !exactAvailable.has(id));
    const searchTargetEpisodeId = request.kind === 'series' && missingIds.length > 0 ?
      missingIds[(pass - 1) % missingIds.length] : null;
    try { found = await discoverCandidates({ requestId, searchTargetEpisodeId }); }
    catch { return held('release_search_unavailable'); }
    if (found?.state !== 'candidates') {
      return held(validReason(found?.reason) ? found.reason :
        'release_search_unavailable');
    }
    if (found.requestId !== requestId || found.anidbId !== request.anidbId ||
        !Array.isArray(found.items) || found.items.length > 50 ||
        found.items.some((candidate) => !validId(candidate?.indexerId) ||
          typeof candidate.guid !== 'string' || !candidate.guid ||
          candidate.guid.length > MAX_RELEASE_GUID_LENGTH ||
          candidate.evidence !== 'unverified' ||
          (candidate.targetedEpisode !== undefined &&
            typeof candidate.targetedEpisode !== 'boolean'))) {
      return held('release_search_unavailable');
    }
    if (found.items.length === 0) return { ...held('no_release_candidates'),
      nextCandidateOffset: 0 };
    // Inspect exact-episode search hits before broad title hits, then prefer
    // peers within each group. This is ordering only: metainfo, ownership and
    // exact file checks still decide whether a release is safe.
    const candidates = [...new Map(found.items.map((item) =>
      [`${item.indexerId}:${item.guid}`, item])).values()].sort((a, b) => {
      if (a.targetedEpisode !== b.targetedEpisode) {
        return Number(b.targetedEpisode === true) -
          Number(a.targetedEpisode === true);
      }
      const peers = (item) => Number.isSafeInteger(item.seeders) &&
        item.seeders >= 0 ? item.seeders : -1;
      return peers(b) - peers(a);
    });
    const candidateId = (item) => createHash('sha256').update(
      JSON.stringify([item.indexerId, item.guid])).digest('hex');
    const currentById = new Map(candidates.map((item) =>
      [candidateId(item), item]));
    // Only a changed target set restarts a sweep. Indexers can add/drop
    // releases between pages; keep the still-present unvisited releases in
    // order and append newcomers so churn cannot starve an older candidate.
    // A rotated episode search may promote an unvisited release. Promote it
    // within the unvisited suffix without repeating already inspected items.
    const fingerprint = createHash('sha256').update(JSON.stringify(
      ['targeted-first-v1', ...[...request.episodeIds].sort((a, b) => a - b)]))
      .digest('hex');
    const saved = typeof candidateFingerprint === 'string' &&
      candidateFingerprint.length <= 3_400 ? candidateFingerprint.split(':') : [];
    const savedGroups = saved.length === 2 && saved[0] === fingerprint ?
      saved[1].split('|') : [];
    const originalOrder = savedGroups.length >= 1 && savedGroups.length <= 2 ?
      savedGroups[0].split(',').filter(Boolean) : [];
    const appendedOrder = savedGroups.length === 2 ?
      savedGroups[1].split(',').filter(Boolean) : [];
    const savedOrder = [...originalOrder, ...appendedOrder];
    const sameTarget = savedOrder.length > 0 &&
      new Set(savedOrder).size === savedOrder.length &&
      savedOrder.every((id) => /^[0-9a-f]{64}$/.test(id));
    const consumed = sameTarget ? savedOrder.slice(0, candidateOffset)
      .filter((id) => currentById.has(id)) : [];
    const remaining = sameTarget ? savedOrder.slice(candidateOffset)
      .filter((id) => currentById.has(id)) : [];
    const previous = new Set(savedOrder);
    const newcomers = sameTarget ? [...currentById.keys()]
      .filter((id) => !previous.has(id)) : [];
    const originalIds = new Set(originalOrder);
    const priorityRemaining = [
      ...remaining.filter((id) => originalIds.has(id) &&
        currentById.get(id).targetedEpisode === true),
      ...remaining.filter((id) => originalIds.has(id) &&
        currentById.get(id).targetedEpisode !== true),
      ...remaining.filter((id) => !originalIds.has(id)),
    ];
    // New discoveries join after the saved sweep. A fresh targeted result on
    // every pass must not starve older unvisited candidates indefinitely.
    const order = sameTarget ? [...consumed, ...priorityRemaining, ...newcomers] :
      [...currentById.keys()];
    const ordered = order.map((id) => currentById.get(id));
    const primaryIds = sameTarget ? order.filter((id) => originalIds.has(id)) : order;
    const tailIds = sameTarget ? order.filter((id) => !originalIds.has(id)) : [];
    const cursor = `${fingerprint}:${primaryIds.join(',')}|${tailIds.join(',')}`;
    const seen = new Set();
    let selected;
    const start = consumed.length < ordered.length ? consumed.length : 0;
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
      // Current exact public proof makes this release unnecessary. Inspect
      // another candidate in the same bounded run so older episodes are not
      // delayed by a separate queue retry for each new-episode release.
      if (preview.episodeIds.every((id) => exactAvailable.has(id))) continue;
      if (inspectCandidateTargets) {
        let claim;
        try { claim = await inspectCandidateTargets({ requestId, candidate,
          episodeIds: preview.episodeIds }); }
        catch { return held('claim_probe_unavailable'); }
        if (claim?.state === 'skip_active') continue;
        if (claim?.state !== 'eligible') return held('claim_probe_unavailable');
      }
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
        detail.kind !== request.kind || typeof detail.restricted !== 'boolean') {
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
      // The attempt now owns its exact target. Keep the request's search
      // position moving so a Shoko hold for this episode cannot starve later
      // episodes. The ledger still prevents a second claim for that target.
      return { state: 'stopped_observed', attemptId: outcome.attemptId,
        nextCandidateOffset: nextIndex < ordered.length ? nextIndex : 0,
        nextCandidateFingerprint: cursor };
    }
    // This result is issued before any reservation or torrent dispatch. A
    // later candidate may cover another requested episode that is still
    // missing. An exhausted uncertain attempt also advances: the ledger
    // blocks another uncertain claim for its episode, while a disjoint later
    // episode can still be acquired. Provider-wide uncertainty retries here.
    if (outcome?.state === 'held' &&
        (outcome.reason === 'target_already_available' ||
          (outcome.reason === 'target_not_proven_unimported' &&
            selected.preview.episodeIds.includes(outcome.episodeId) &&
            exactAvailable.has(outcome.episodeId)) ||
          outcome.reason === 'candidate_rejected' ||
          outcome.reason === 'candidate_retired' ||
          outcome.reason === 'candidate_released' ||
          outcome.reason === 'target_busy' ||
          outcome.reason === 'uncertain_attempt_exhausted' ||
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
