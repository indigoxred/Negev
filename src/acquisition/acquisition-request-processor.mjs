import { isCompleteAniDbDetail } from '../catalogue/hydration-ledger.mjs';
import { matchesTrustedReleaseTitle, planTorrentTargets } from './plan-torrent-targets.mjs';
import { createHash } from 'node:crypto';
import { assessRelease, compareReleases, compareReleaseSuitability, compareReleaseRecognitionTier, hasSeasonPackHint,
  hasSingleEpisodeHint } from './release-preference.mjs';
import { MAX_RELEASE_GUID_LENGTH } from './release-candidate-limits.mjs';
import { checkRelatedInstallment } from './related-installment-guard.mjs';
import { correspondenceLevel, publicRelease } from './release-selection.mjs';
import { sameReleaseFiles } from './release-control.mjs';
import { matchesPreferredGroup } from './preferred-release.mjs';
import { matchesReleaseFilters } from '../web/public/release-choice-fields.mjs';

const held = (reason) => ({ state: 'held', reason });
const validId = (value) => Number.isSafeInteger(value) && value > 0;
const validReason = (value) => typeof value === 'string' &&
  /^[a-z][a-z0-9_]{0,79}$/.test(value);

// One request, at most a few read-only candidate inspections, and at most one
// stopped submission. The submit callback must be the guarded coordinator;
// this processor cannot authorize absence or start the resulting torrent.
export function createAcquisitionRequestProcessor({ readRequest,
  discoverCandidates, previewCandidate, loadDetail, submitCandidate,
  readPublicCoverage, inspectCandidateTargets, readRecoveredTargets,
  readRelatedTitles, releaseQueries = async () => [],
  readReleaseControl, consumeReleaseChoice, readChosenAttempt,
  checkPreferredRelease, getPreferredFallback, closePreferredWaits,
  preferRegisteredCorrespondence = false,
  preferShokoPreview = false, requireReleasePolicy = false,
  maxPreflights = 3, now = Date.now } = {}) {
  if ([readRequest, discoverCandidates, previewCandidate, loadDetail,
    submitCandidate].some((fn) => typeof fn !== 'function') ||
      (readPublicCoverage !== undefined && typeof readPublicCoverage !== 'function') ||
      (inspectCandidateTargets !== undefined &&
        typeof inspectCandidateTargets !== 'function') ||
      (readRecoveredTargets !== undefined &&
        typeof readRecoveredTargets !== 'function') ||
      (readRelatedTitles !== undefined &&
        typeof readRelatedTitles !== 'function') ||
      [readReleaseControl,consumeReleaseChoice,readChosenAttempt,checkPreferredRelease,getPreferredFallback,closePreferredWaits].some(fn=>fn!==undefined&&typeof fn!=='function') ||
      typeof preferRegisteredCorrespondence!=='boolean' ||
      typeof preferShokoPreview !== 'boolean' ||
      typeof releaseQueries !== 'function' ||
      typeof requireReleasePolicy !== 'boolean' ||
      typeof now !== 'function' ||
      !Number.isSafeInteger(maxPreflights) || maxPreflights < 1 ||
      maxPreflights > 5) throw new TypeError('Invalid acquisition processor');
  return async ({ requestId, pass = 1, candidateOffset = 0,
    candidateFingerprint = null, scanStartedMs = null } = {}) => {
    const strongerRequiredTier=(a,b)=>preferRegisteredCorrespondence
      ? compareReleaseRecognitionTier(a,b)<0
      : compareReleaseSuitability(a,b)<0;
    if (!validId(requestId) || !validId(pass) ||
        (scanStartedMs !== null &&
          (!Number.isSafeInteger(scanStartedMs) || scanStartedMs < 0)) ||
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
    const control = readReleaseControl?.(requestId,now());
    if(control && ['selecting','proposal'].includes(control.phase)) return held('release_selection_pending');
    let pinned=control?.phase==='chosen'?control.selection:null;
    if(pinned&&readChosenAttempt) {
      const owned=await readChosenAttempt({requestId,candidate:pinned.candidate,
        episodeIds:pinned.preview.episodeIds});
      if(owned?.torrentHash===pinned.preview.torrentHash&&
          sameReleaseFiles(owned.files,pinned.preview.files)) {
        consumeReleaseChoice?.(requestId,control.revision);pinned=null;
      }
    }
    if(pinned) {
      if(pinned.preview.episodeIds.some(id=>!request.episodeIds.includes(id))) return held('release_choice_changed');
      request={...request,episodeIds:[...pinned.preview.episodeIds]};
      candidateOffset=0;candidateFingerprint=null;
    }
    let recoveredTargets = new Set();
    if (readRecoveredTargets) {
      let ids;
      try { ids = await readRecoveredTargets(requestId); }
      catch { return held('recovery_unavailable'); }
      if (!Array.isArray(ids) || ids.some((id) => !validId(id))) {
        return held('recovery_unavailable');
      }
      recoveredTargets = new Set(ids);
    }
    let exactAvailable = new Set();
    let uncertainOwned = new Set();
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
      if (coverage.uncertainEpisodeIds !== undefined) {
        const ids = coverage.uncertainEpisodeIds;
        if (!Array.isArray(ids) || new Set(ids).size !== ids.length ||
            ids.some((id) => !request.episodeIds.includes(id) || exactAvailable.has(id))) {
          return held('availability_unverified');
        }
        uncertainOwned = new Set(ids);
      }
      if (coverage.verifiedTargets === request.episodeIds.length) {
        if(pinned) consumeReleaseChoice?.(requestId,control.revision);
        return { ...held('request_fully_available'), nextCandidateOffset: 0 };
      }
    }
    let found, expiredFallback;
    const missingIds = request.episodeIds.filter((id) =>
      !exactAvailable.has(id) && !uncertainOwned.has(id));
    if (missingIds.length === 0) return held('availability_unverified');
    const searchTargetEpisodeId = request.kind === 'series' && missingIds.length > 0 ?
      missingIds[(pass - 1) % missingIds.length] : null;
    try { found = pinned ? {state:'candidates',requestId,anidbId:request.anidbId,
      items:[{...pinned.candidate,evidence:'unverified'}]} : await discoverCandidates({ requestId, searchTargetEpisodeId,
      ...(missingIds.length > 1 && missingIds.length <= 10 ?
        { searchTargetEpisodeIds: missingIds } : {}) }); }
    catch { found=held('release_search_unavailable'); }
    if(!pinned&&control?.preference&&getPreferredFallback) {
      expiredFallback=getPreferredFallback(requestId,missingIds,now());
      if(expiredFallback){
        const items=found?.state==='candidates'&&Array.isArray(found.items)?found.items:[];
        found={...found,state:'candidates',requestId,anidbId:request.anidbId,releaseState:'airing',
          items:[expiredFallback.candidate,...items.filter(c=>c.guid!==expiredFallback.candidate.guid||c.indexerId!==expiredFallback.candidate.indexerId)].slice(0,50)};
        candidateOffset=0;candidateFingerprint=null;
      }
    }
    if (found?.state !== 'candidates') {
      return held(validReason(found?.reason) ? found.reason :
        'release_search_unavailable');
    }
    if (found.requestId !== requestId || found.anidbId !== request.anidbId ||
        !Array.isArray(found.items) || found.items.length > 50 ||
        (found.releaseState !== undefined &&
          !['completed', 'airing', 'upcoming'].includes(found.releaseState)) ||
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
    const preferSeasonPack = requireReleasePolicy && request.kind === 'series' &&
      missingIds.length > 1 && found.releaseState === 'completed';
    let safeTitles = found.items;
    if (readRelatedTitles) {
      let related;
      try { related = await readRelatedTitles({ anidbId: request.anidbId }); }
      catch { return held('related_title_unavailable'); }
      let requestedAliases = [];
      try { requestedAliases = await releaseQueries({ anidbId: request.anidbId }); }
      catch { /* Canonical checks remain conservative if aliases are unavailable. */ }
      safeTitles = [];
      for (const item of found.items) {
        // Reject a known different installment before spending a metainfo
        // read or a place in the bounded three-candidate preview. File names
        // are checked again after metainfo is fetched for surviving titles.
        const checked = checkRelatedInstallment({ anidbId: request.anidbId,
          requestedTitle: request.title, requestedAliases, related, releaseTitle: item.title,
          fileNames: [item.title] });
        if (checked.reason === 'related_title_unavailable') return checked;
        if (checked.state === 'related_title_clear') safeTitles.push(item);
      }
    }
    if (requireReleasePolicy) {
      if(!pinned&&control?.preference){
        const audio=control.preference.audio==='japanese'?'japanese_dual':control.preference.audio;
        safeTitles=safeTitles.filter(item=>matchesReleaseFilters(item,{quality:'all',audio})).map(item=>{
          const {selectionPolicy,...automatic}=item;
          return audio==='english'?{...automatic,selectionPolicy:{allowEnglishDub:true}}:automatic;
        });
      }
      safeTitles = safeTitles.filter((item) => assessRelease(item).eligible);
    }
    if (safeTitles.length === 0) return { ...held('no_safe_release'),
      nextCandidateOffset: 0 };
    // Prefer a release with reported peers before a zero-seeder result.
    // Among those, inspect exact-episode hits before broad title hits.
    // Metainfo, ownership and exact file checks still decide safety.
    const candidates = [...new Map(safeTitles.map((item) =>
      [`${item.indexerId}:${item.guid}`, item])).values()].sort((a, b) => {
      if(requireReleasePolicy){
        if(!pinned&&control?.preference&&found.releaseState==='airing'&&
          assessRelease(a).healthyPeers===assessRelease(b).healthyPeers&&
          publicRelease(a).resolution===publicRelease(b).resolution&&
          a.targetedEpisode===b.targetedEpisode){
          const preferred=Number(matchesPreferredGroup(b,control.preference.group))-Number(matchesPreferredGroup(a,control.preference.group));
          if(preferred)return preferred;
        }
        return compareReleases(a,b,{preferSeasonPack});
      }
      const peers = (item) => Number.isSafeInteger(item.seeders) &&
        item.seeders >= 0 ? item.seeders : -1;
      if ((peers(a) > 0) !== (peers(b) > 0)) {
        return Number(peers(b) > 0) - Number(peers(a) > 0);
      }
      if (a.targetedEpisode !== b.targetedEpisode) {
        return Number(b.targetedEpisode === true) -
          Number(a.targetedEpisode === true);
      }
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
    // A saved v1 cursor may have consumed a strong release during a transient
    // Prowlarr re-search failure. Revisit it once with the preserved proxy.
    const packFingerprint = createHash('sha256').update(JSON.stringify(
      [preferSeasonPack ? 'quality-policy-season-pack-v3' :
        requireReleasePolicy ? 'quality-policy-v5' :
        readRelatedTitles ? 'targeted-related-peers-v3' : 'targeted-peers-v2',
        ...[...request.episodeIds].sort((a, b) => a - b)]))
      .digest('hex');
    const fallbackFingerprint = preferSeasonPack ? createHash('sha256')
      .update(JSON.stringify(['quality-policy-episode-fallback-v3',
        ...[...request.episodeIds].sort((a, b) => a - b)]))
      .digest('hex') : null;
    const uncertainPackFingerprint = preferSeasonPack && preferShokoPreview ?
      createHash('sha256').update(JSON.stringify(
        ['quality-policy-uncertain-pack-v3',
          ...[...request.episodeIds].sort((a, b) => a - b)]))
        .digest('hex') : null;
    const saved = typeof candidateFingerprint === 'string' &&
      candidateFingerprint.length <= 3_400 ? candidateFingerprint.split(':') : [];
    const knownPhase = saved.length === 2 &&
      (saved[0] === packFingerprint || saved[0] === fallbackFingerprint ||
        saved[0] === uncertainPackFingerprint);
    const savedGroups = knownPhase ?
      saved[1].split('|') : [];
    const originalOrder = savedGroups.length >= 1 && savedGroups.length <= 2 ?
      savedGroups[0].split(',').filter(Boolean) : [];
    const appendedOrder = savedGroups.length === 2 ?
      savedGroups[1].split(',').filter(Boolean) : [];
    const savedOrder = [...originalOrder, ...appendedOrder];
    const validSavedOrder = savedOrder.length > 0 &&
      new Set(savedOrder).size === savedOrder.length &&
      savedOrder.every((id) => /^[0-9a-f]{64}$/.test(id));
    const fallbackPhase = preferSeasonPack &&
      saved[0] === fallbackFingerprint &&
      validSavedOrder;
    const uncertainPackPhase = preferSeasonPack && preferShokoPreview &&
      saved[0] === uncertainPackFingerprint &&
      validSavedOrder;
    const fingerprint = fallbackPhase ? fallbackFingerprint :
      uncertainPackPhase ? uncertainPackFingerprint : packFingerprint;
    const sameTarget = validSavedOrder &&
      (saved[0] === packFingerprint || fallbackPhase || uncertainPackPhase);
    const consumed = sameTarget ? savedOrder.slice(0, candidateOffset)
      .filter((id) => currentById.has(id)) : [];
    const remaining = sameTarget ? savedOrder.slice(candidateOffset)
      .filter((id) => currentById.has(id)) : [];
    const previous = new Set(savedOrder);
    const newcomers = sameTarget ? [...currentById.keys()]
      .filter((id) => !previous.has(id)) : [];
    const originalIds = new Set(originalOrder);
    const priorityRemaining = requireReleasePolicy ?
      [...remaining, ...newcomers].sort((left, right) =>
        compareReleases(currentById.get(left), currentById.get(right),
          { preferSeasonPack })) : [
      ...remaining.filter((id) => originalIds.has(id) &&
        currentById.get(id).targetedEpisode === true),
      ...remaining.filter((id) => originalIds.has(id) &&
        currentById.get(id).targetedEpisode !== true),
      ...remaining.filter((id) => !originalIds.has(id)),
    ];
    // New discoveries join after the saved sweep. A fresh targeted result on
    // every pass must not starve older unvisited candidates indefinitely.
    const savedSweep = sameTarget ? [...consumed, ...priorityRemaining,
      ...(requireReleasePolicy ? [] : newcomers)] :
      [...currentById.keys()];
    // The completed-season scan has already inspected every candidate.
    // On its fallback pass, lead with non-pack releases instead of spending
    // another bounded page on the same failed pack hints.
    const order = fallbackPhase ? [
      ...savedSweep.filter((id) => !hasSeasonPackHint(currentById.get(id))),
      ...savedSweep.filter((id) => hasSeasonPackHint(currentById.get(id))),
    ] : savedSweep;
    const ordered = order.map((id) => currentById.get(id));
    // A policy newcomer can be promoted ahead of an old low-quality fallback.
    // Save the actual inspected order or the offset would point at a different
    // candidate on the next pass.
    const primaryIds = sameTarget && !requireReleasePolicy ?
      order.filter((id) => originalIds.has(id)) : order;
    const tailIds = sameTarget && !requireReleasePolicy ?
      order.filter((id) => !originalIds.has(id)) : [];
    const cursor = `${fingerprint}:${primaryIds.join(',')}|${tailIds.join(',')}`;
    const seen = new Set();
    const offlineCache = new Map();
    let selected;
    let uncertainSelection;
    let groupWait;
    const deferredEpisodes=new Set();
    const deferredCandidates=[];
    const start = consumed.length < ordered.length ? consumed.length : 0;
    let nextIndex = start;
    let freshReads = 0;
    let transientFailure = false;
    for (let index = start; index < ordered.length; index++) {
      if (freshReads >= maxPreflights) break;
      const candidate = ordered[index];
      nextIndex = index + 1;
      if (preferSeasonPack && !fallbackPhase &&
          hasSingleEpisodeHint(candidate)) continue;
      // A fuzzy result from an exact-episode query can explicitly name a
      // different episode. It should not consume a metainfo read or the
      // bounded preview budget for the missing target.
      if (candidate.targetEpisodeId !== undefined &&
          candidate.targetedEpisode === false &&
          hasSingleEpisodeHint(candidate)) continue;
      const key = `${candidate.indexerId}:${candidate.guid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let preview;
      try { preview = await previewCandidate({ requestId, candidate,
        offlineCache }); }
      catch { freshReads++; transientFailure = true; continue; }
      if(expiredFallback&&candidate.guid===expiredFallback.candidate.guid&&candidate.indexerId===expiredFallback.candidate.indexerId&& (preview?.state!=='preflight'||preview.torrentHash!==expiredFallback.preview.torrentHash||
          !sameReleaseFiles(preview.files,expiredFallback.preview.files))){
        if(preview?.state==='preflight'||['release_title_mismatch','shoko_preview_wrong_identity','invalid_metainfo'].includes(preview?.reason))
          closePreferredWaits?.(requestId,expiredFallback.preview.episodeIds,now());
        return held('release_preflight_unavailable');
      }
      if(pinned && (preview?.state!=='preflight' ||
        preview.torrentHash!==pinned.preview.torrentHash ||
        !sameReleaseFiles(preview.files,pinned.preview.files) ||
        JSON.stringify(preview.episodeIds)!==JSON.stringify(pinned.preview.episodeIds))) {
        return held(preview?.state==='held'?preview.reason:'release_choice_changed');
      }
      if (preview?.cacheHit !== true) freshReads++;
      if (preview?.state === 'held' && ['provider_unavailable',
        'torrent_preflight_unavailable', 'related_title_unavailable',
        'shoko_settings_unavailable', 'metadata_reader_busy', 'detail_unavailable',
        'candidate_changed', 'torrent_unavailable'].includes(preview.reason)) {
        transientFailure = true;
      }
      if (preview?.state !== 'preflight' ||
          preview.requestId !== requestId ||
          preview.anidbId !== request.anidbId ||
          typeof preview.torrentHash !== 'string' ||
          !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(preview.torrentHash) ||
          (preview.searchQuery !== undefined &&
            (typeof preview.searchQuery !== 'string' ||
              preview.searchQuery.length < 2 || preview.searchQuery.length > 120 ||
              /[\x00-\x1f\x7f]/.test(preview.searchQuery))) ||
          (preview.identityTitle !== undefined &&
            (typeof preview.identityTitle !== 'string' ||
              preview.identityTitle.length < 2 || preview.identityTitle.length > 120 ||
              /[\x00-\x1f\x7f]/.test(preview.identityTitle) ||
              !matchesTrustedReleaseTitle(candidate.title, preview.identityTitle))) ||
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
      if (preview.episodeIds.some((id) => uncertainOwned.has(id))) continue;
      if (preview.episodeIds.some((id) => recoveredTargets.has(id)) &&
          preview.shokoPreview !== 'exact') continue;
      if (inspectCandidateTargets) {
        let claim;
        try { claim = await inspectCandidateTargets({ requestId, candidate,
          episodeIds: preview.episodeIds }); }
        catch { return held('claim_probe_unavailable'); }
        if (claim?.state === 'skip_active') continue;
        if (claim?.state !== 'eligible') return held('claim_probe_unavailable');
      }
      if (preferSeasonPack && !fallbackPhase &&
          missingIds.some((id) => !preview.episodeIds.includes(id))) {
        continue;
      }
      if(!pinned&&control?.preference&&checkPreferredRelease){
        const durableAlternative=getPreferredFallback?.(requestId,preview.episodeIds,now(),true);
        if(durableAlternative&&strongerRequiredTier(durableAlternative.candidate,candidate)){
          const waiting=checkPreferredRelease({requestId,...durableAlternative,releaseState:found.releaseState,nowMs:now()});
          if(waiting?.reason==='preferred_group_wait'){
            groupWait={...waiting,retryAtMs:Math.min(groupWait?.retryAtMs??Infinity,waiting.retryAtMs)};
            for(const id of durableAlternative.preview.episodeIds)deferredEpisodes.add(id);
            continue;
          }
        }
        // Waiting for a preferred group cannot authorize a lower-quality or
        // unhealthy release for the same episode. Independent episodes still
        // proceed through the bounded loop.
        if(deferredCandidates.some(prior=>prior.episodeIds.some(id=>preview.episodeIds.includes(id))&&
            strongerRequiredTier(prior.candidate,candidate)))continue;
        const waiting=checkPreferredRelease({requestId,candidate,preview,
          releaseState:found.releaseState,nowMs:now()});
        if(waiting?.state==='held'){
          if(waiting.reason!=='preferred_group_wait')return waiting;
          groupWait={...waiting,retryAtMs:Math.min(groupWait?.retryAtMs??Infinity,waiting.retryAtMs)};
          for(const id of preview.episodeIds)deferredEpisodes.add(id);
          deferredCandidates.push({candidate,episodeIds:preview.episodeIds});
          continue;
        }
      }
      if (!pinned && preferShokoPreview && !uncertainPackPhase &&
          !(control?.preference&&found.releaseState==='airing'&&matchesPreferredGroup(candidate,control.preference.group))&&
          (preferRegisteredCorrespondence ? correspondenceLevel(preview)==='unknown' : preview.shokoPreview !== 'exact')) {
        if (!uncertainSelection || compareReleases(candidate,
          uncertainSelection.candidate, { preferSeasonPack }) < 0) {
          uncertainSelection = { candidate, preview, index };
        }
        continue;
      }
      if (uncertainSelection && requireReleasePolicy &&
          !uncertainPackPhase) {
        if (strongerRequiredTier(uncertainSelection.candidate, candidate)) {
          selected = uncertainSelection;
          nextIndex = uncertainSelection.index + 1;
          break;
        }
      }
      // Earlier preview pages may contain a stronger pack whose Shoko match
      // was uncertain. Do not let an exact but weaker pack win solely because
      // the stronger preview fell on the previous worker turn. The next
      // bounded uncertain-pack phase revisits those candidates and validates
      // them again before any submission.
      if (preferSeasonPack && preferShokoPreview && !uncertainPackPhase &&
          (preferRegisteredCorrespondence ? correspondenceLevel(preview)!=='unknown' : preview.shokoPreview === 'exact') && consumed.some((id) => {
            const prior = currentById.get(id);
            if (!prior) return false;
            return strongerRequiredTier(prior, candidate);
          })) continue;
      selected = { candidate, preview };
      break;
    }
    if (!selected && uncertainSelection && (!preferSeasonPack || fallbackPhase)) {
      selected = uncertainSelection;
      nextIndex = uncertainSelection.index + 1;
    }
    if(!selected&&groupWait)return {...groupWait,
      retryAtMs:transientFailure||nextIndex<ordered.length||missingIds.some(id=>!deferredEpisodes.has(id))?
        Math.min(groupWait.retryAtMs,now()+60_000):groupWait.retryAtMs,
      nextCandidateOffset:nextIndex<ordered.length?nextIndex:0,nextCandidateFingerprint:cursor};
    if (!selected && transientFailure) return { ...held('release_preflight_unavailable'),
      nextCandidateOffset: nextIndex < ordered.length ? nextIndex : 0,
      nextCandidateFingerprint: cursor };
    if (!selected && preferSeasonPack && !fallbackPhase) {
      const exhausted = nextIndex >= ordered.length;
      const nextPhaseFingerprint = uncertainPackPhase || !preferShokoPreview ?
        fallbackFingerprint : uncertainPackFingerprint;
      const nextPhaseCursor = `${nextPhaseFingerprint}:${primaryIds.join(',')}|${tailIds.join(',')}`;
      return { ...held(exhausted ? uncertainPackPhase ?
        'season_pack_uncertain_complete' : 'season_pack_scan_complete' :
        'season_pack_search_pending'),
        nextCandidateOffset: nextIndex,
        nextCandidateFingerprint: exhausted ? nextPhaseCursor : cursor };
    }
    if (!selected) return { ...held('no_safe_release'),
      nextCandidateOffset: nextIndex < ordered.length ? nextIndex : 0,
      nextCandidateFingerprint: cursor };
    // A failed alias/indexer query is not evidence that only a lower-quality
    // fallback exists. Retry the complete bounded search before downgrading.
    const exactExpiredFallback=expiredFallback&&
      selected.candidate.guid===expiredFallback.candidate.guid&&
      selected.candidate.indexerId===expiredFallback.candidate.indexerId&&
      selected.preview.torrentHash===expiredFallback.preview.torrentHash&&
      sameReleaseFiles(selected.preview.files,expiredFallback.preview.files);
    if (found.searchIncomplete === true && !exactExpiredFallback &&
        (publicRelease(selected.candidate).resolution??0) < 1080) {
      return { ...held('release_search_incomplete'),
        nextCandidateOffset: 0 };
    }
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
      trustedTitle: selected.preview.identityTitle ?? detail.title });
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
      closePreferredWaits?.(requestId,selected.preview.episodeIds,now());
      if(pinned) consumeReleaseChoice?.(requestId,control.revision);
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
            selected.preview.episodeIds.includes(outcome.episodeId)) ||
          outcome.reason === 'candidate_rejected' ||
          outcome.reason === 'candidate_retired' ||
          outcome.reason === 'candidate_released' ||
          outcome.reason === 'candidate_hash_in_use' ||
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
