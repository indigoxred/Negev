import { verifyAbsoluteNumberingScope } from './absolute-numbering-scope.mjs';
import { prepareStoppedCandidate } from './prepare-stopped-candidate.mjs';
import { reserveMissingTargets } from './reserve-missing-targets.mjs';
import { submitStoppedCandidate } from './submit-stopped-candidate.mjs';
import { isOptionalClip, torrentFileKind } from './evaluate-stopped-manifest.mjs';
import { matchesTrustedReleaseTitle, matchesSeasonLabelledTitle, planTorrentTargets } from './plan-torrent-targets.mjs';
import { isCompleteAniDbDetail } from '../catalogue/hydration-ledger.mjs';
import { trustedReleaseQueries, trustedIdentityTitles, trustedTargetedQueries, trustedPackQueries } from './trusted-release-queries.mjs';
import { checkRelatedInstallment } from './related-installment-guard.mjs';
import { evaluateOfflinePreview } from '../identity/evaluate-offline-preview.mjs';
import { basename } from 'node:path';
import { planPackBonuses } from './pack-bonus-plan.mjs';
import { refreshBonusOwnership } from './bonus-ownership.mjs';
import { readBoundedJson } from '../http/bounded-response.mjs';
import { qbittorrentSessionCookie } from './qbittorrent-session-cookie.mjs';

const held = (reason) => ({ state: 'held', reason });

function exactFilePlan(prepared, plannedFiles, episodeIds, allowOptionalClips) {
  if (!Array.isArray(plannedFiles) || plannedFiles.length < 1 || plannedFiles.length > 50 ||
      !Array.isArray(episodeIds) || episodeIds.length < 1 || episodeIds.length > 50) return false;
  const plannedByName = new Map();
  const plannedTargets = new Set();
  for (const file of plannedFiles) {
    if (typeof file?.name !== 'string' || torrentFileKind(file.name) !== 'video' ||
        plannedByName.has(file.name.toLowerCase()) ||
        !Number.isSafeInteger(file.size) || file.size < 1 ||
        !Array.isArray(file.episodeIds) || file.episodeIds.length < 1) return false;
    plannedByName.set(file.name.toLowerCase(), file);
    for (const id of file.episodeIds) {
      if (!Number.isSafeInteger(id) || id < 1 || plannedTargets.has(id)) return false;
      plannedTargets.add(id);
    }
  }
  if (plannedTargets.size !== episodeIds.length ||
      episodeIds.some((id) => !plannedTargets.has(id))) return false;
  const videos = prepared.files.filter((file) =>
    torrentFileKind(file.name) === 'video' &&
    !(allowOptionalClips && isOptionalClip(file.name) &&
      !plannedByName.has(file.name.toLowerCase())));
  if (videos.length !== plannedFiles.length || prepared.files.some((file) =>
    !['video', 'subtitle', 'passive'].includes(torrentFileKind(file.name)))) return false;
  return videos.every((file) => {
    const planned = plannedByName.get(file.name.toLowerCase());
    return planned?.name === file.name && planned.size === file.size;
  });
}

// Server-side controlled-acquisition boundary. The caller must have chosen
// the release and exact episode subset; a title match alone cannot do that.
// This prepares and submits only a stopped torrent. No bytes enter Shoko here.
export async function submitMissingCandidate({ request, candidate, detail, episodeIds,
  plannedFiles, expectedHash, searchQuery, releaseQueries = async () => [],
  readRelatedTitles, offlineLookup, loadDetail, readVideoExtensions, readBonusOwnership,
  allowRestrictedBonuses = false,
  readEvidence, publicLibraryIds, ledger,
  renewQbittorrent,
  firstTimePolicy = 'strict', now = Date.now, prowlarr, qbittorrent }) {
  if (!prowlarr || !qbittorrent || typeof now !== 'function' ||
      typeof releaseQueries !== 'function' ||
      (readRelatedTitles !== undefined && typeof readRelatedTitles !== 'function') ||
      (offlineLookup !== undefined && typeof offlineLookup !== 'function') ||
      (renewQbittorrent !== undefined && typeof renewQbittorrent !== 'function') ||
      !['strict', 'single_uncertain_attempt'].includes(firstTimePolicy) ||
      (expectedHash !== undefined &&
        (typeof expectedHash !== 'string' ||
        !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(expectedHash)))) {
    throw new TypeError('Invalid stopped acquisition configuration');
  }
  if (!isCompleteAniDbDetail(detail, request?.anidbId) ||
      detail.kind !== request.kind) return held('detail_unavailable');
  if (typeof detail.restricted !== 'boolean') return held('restricted_or_unverified');
  const catalogueIds = new Set(detail.episodes.map((episode) => episode.id));
  if (!Array.isArray(request.episodeIds) || request.episodeIds.length === 0 ||
      request.episodeIds.some((id) => !catalogueIds.has(id))) {
    return held('target_missing');
  }
  // Request preflight searches the canonical AniDB title but omits the
  // query from its response. Reconstruct that same trusted query here rather
  // than relying on a global Prowlarr query that the runtime does not set.
  let selectedQuery = trustedReleaseQueries(detail.title)[0];
  let aliases = [];
  if (searchQuery !== undefined) {
    try { aliases = await releaseQueries({ anidbId: request.anidbId }); }
    catch { return held('trusted_query_unavailable'); }
    const trusted = trustedReleaseQueries(detail.title, aliases);
    const targeted = Array.isArray(episodeIds) && episodeIds.some((id) => {
      const episode = detail.episodes.find((entry) => entry.id === id &&
        entry.type === 'Episode');
      return episode && trustedTargetedQueries(detail.title,
        aliases, episode.number).includes(searchQuery);
    });
    if (!trusted.includes(searchQuery) && !targeted &&
        !trustedPackQueries(detail.title, aliases).includes(searchQuery)) {
      return held('untrusted_release_query');
    }
    selectedQuery = searchQuery;
  }
  if (!selectedQuery) return held('untrusted_release_query');
  const verifiedIdentity = trustedIdentityTitles(detail.title, aliases)
    .find((query) => matchesTrustedReleaseTitle(candidate?.title, query));
  const identityQuery = verifiedIdentity ??
    trustedReleaseQueries(detail.title, aliases)
      .find((query) => matchesTrustedReleaseTitle(candidate?.title, query)) ??
    trustedIdentityTitles(detail.title, aliases)
      .find((title) => matchesSeasonLabelledTitle(candidate?.title, title));
  if (!identityQuery) return held('release_title_mismatch');
  if (!verifiedIdentity && !offlineLookup) return held('release_title_mismatch');
  if (typeof qbittorrent.verifyStagingRoot === 'function') {
    let staging;
    try { staging = await qbittorrent.verifyStagingRoot(); }
    catch { return held('staging_root_unverified'); }
    if (staging?.state !== 'verified_staging_root') {
      return held('staging_root_unverified');
    }
  }
  const prepared = await prepareStoppedCandidate({ ...prowlarr,
    query: selectedQuery, candidate, saveRoot: qbittorrent.saveRoot });
  if (prepared.state !== 'prepared_stopped') return prepared;
  let related;
  if (readRelatedTitles) {
    try { related = await readRelatedTitles({ anidbId: request.anidbId }); }
    catch { return held('related_title_unavailable'); }
  }
  let extensions;
  if(readVideoExtensions){try{extensions=await readVideoExtensions()}catch{/* Main extension checks remain at start. */}}
  const bonus = await planPackBonuses({request,detail,files:prepared.files,related,offlineLookup,
    loadDetail,readOwnership:readBonusOwnership,allowRestricted:allowRestrictedBonuses,videoExtensions:extensions});
  const mainPrepared={...prepared,files:bonus.mainFiles};
  if(readRelatedTitles){
    const checked = checkRelatedInstallment({ anidbId: request.anidbId,
      requestedTitle: detail.title, related, releaseTitle: candidate.title,
      fileNames: mainPrepared.files.filter((file) =>
        torrentFileKind(file.name) === 'video').map((file) => file.name) });
    if (checked.state !== 'related_title_clear') return checked;
  }
  if (expectedHash !== undefined &&
      prepared.expected.hash.toLowerCase() !== expectedHash.toLowerCase()) {
    return held('preflight_torrent_changed');
  }
  const allowOptionalClips = !detail.episodes.some((episode) =>
    episode.type === 'Special' && request.episodeIds.includes(episode.id));
  if ((episodeIds !== undefined || plannedFiles !== undefined) &&
      !exactFilePlan(mainPrepared, plannedFiles, episodeIds, allowOptionalClips)) {
    return held('file_plan_mismatch');
  }
  // Re-derive the episode map even when a caller supplies a reviewed plan.
  // The final server boundary cannot trust stale or forged preflight fields.
  const mapped = planTorrentTargets({ request, detail, prepared:mainPrepared,
    releaseTitle: candidate.title, trustedTitle: identityQuery,
    allowTitleMetadataVariation: !verifiedIdentity });
  if (mapped.state !== 'planned_targets') return mapped;
  const selectedEpisodeIds = episodeIds ?? mapped.episodeIds;
  const selectedFiles = plannedFiles ?? mapped.plannedFiles;
  if (!exactFilePlan(mainPrepared, selectedFiles, selectedEpisodeIds,
    allowOptionalClips)) return held('file_plan_mismatch');
  const mappedByName = new Map(mapped.plannedFiles.map((file) =>
    [file.name, file.episodeIds]));
  if (selectedFiles.some((file) => JSON.stringify([...file.episodeIds]
    .sort((a, b) => a - b)) !== JSON.stringify(mappedByName.get(file.name)))) {
    return held('file_plan_mismatch');
  }
  const absolute = mapped.numberingEvidence === 'complete_absolute_sequence';
  const scope = absolute ? await verifyAbsoluteNumberingScope({ anidbId:request.anidbId,
    offset:mapped.absoluteOffset, related, readRelatedTitles, loadDetail }) : null;
  if (!verifiedIdentity || absolute && scope.state !== 'scope_confirmed') {
    if (typeof offlineLookup !== 'function') return held(absolute ? 'absolute_numbering_unverified' : 'release_title_mismatch');
    for (const file of selectedFiles) {
      if (file.episodeIds.length !== 1) return held('release_title_mismatch');
      const filename = basename(file.name);
      let preview;
      try { preview = await offlineLookup({ filename }); }
      catch { return held(absolute ? 'absolute_numbering_unverified' : 'release_title_mismatch'); }
      if (evaluateOfflinePreview(preview, { animeId: request.anidbId,
        episodeIds: file.episodeIds, filename }).state !== 'accepted') {
        return held(absolute ? 'absolute_numbering_unverified' : 'release_title_mismatch');
      }
    }
  }
  // An old Arr or manual torrent may own this exact hash. Check before a
  // durable target reservation so the request can inspect another candidate
  // instead of holding its episode for a collision it cannot resolve.
  const beforeReserve = expectedHash === undefined ? undefined : async () => {
    let sid = qbittorrent.sessionId;
    let fetchImpl = qbittorrent.fetchImpl;
    let response;
    const observeHash = async () => {
      const url = new URL('/api/v2/torrents/info', qbittorrent.baseUrl);
      url.searchParams.set('hashes', prepared.expected.hash);
      return fetchImpl(url, { method: 'GET', redirect: 'manual',
        headers: { Cookie: qbittorrentSessionCookie(sid),
          Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    };
    try {
      response = await observeHash();
      if (response.status === 403 && renewQbittorrent) {
        const renewed = await renewQbittorrent(sid);
        if (renewed?.state !== 'authenticated' ||
            typeof renewed.sessionId !== 'string' ||
            typeof renewed.fetchImpl !== 'function') {
          return held('authentication_unavailable');
        }
        sid = renewed.sessionId;
        fetchImpl = renewed.fetchImpl;
        response = await observeHash();
      }
      if (response.status === 403) return held('provider_http_403');
      if (response.status !== 200) return held('provider_unavailable');
      const existing = await readBoundedJson(response, 100_000);
      if (!Array.isArray(existing) || existing.some((item) =>
        item?.hash?.toLowerCase() !== prepared.expected.hash.toLowerCase())) {
        return held('provider_unavailable');
      }
      if (existing.length) return held('candidate_hash_in_use');
    } catch { return held('provider_unavailable'); }
    return { state: 'ready' };
  };
  const reserved = await reserveMissingTargets({ request, candidate, episodeIds: selectedEpisodeIds,
    preparedHash:prepared.expected.hash,plannedFiles,
    readEvidence, publicLibraryIds, ledger, firstTimePolicy, now, beforeReserve });
  if (!['reserved', 'existing'].includes(reserved.state)) return reserved;
  // Once the stopped torrent is recorded, start/completion workers own it.
  // Replaying its manifest here cannot make progress after it has downloaded,
  // and must not pin an Airing request ahead of its other episodes.
  if (reserved.state === 'existing' && reserved.status === 'torrent_observed') {
    return held('target_busy');
  }
  // The final first-time evidence read can itself wait two minutes. Renew
  // only after it finishes, just before qBittorrent preflight and dispatch.
  let activeQbittorrent = qbittorrent;
  if (renewQbittorrent) {
    let fresh;
    try { fresh = await renewQbittorrent(qbittorrent.sessionId); }
    catch { return held('authentication_unavailable'); }
    if (fresh?.state !== 'authenticated' ||
        typeof fresh.sessionId !== 'string' ||
        typeof fresh.fetchImpl !== 'function') {
      return held(typeof fresh?.reason === 'string' &&
        /^[a-z][a-z0-9_]{0,79}$/.test(fresh.reason) ?
        fresh.reason : 'authentication_unavailable');
    }
    activeQbittorrent = { ...qbittorrent, sessionId: fresh.sessionId,
      fetchImpl: fresh.fetchImpl };
  }
  const nowMs = now();
  const bound = ledger.bindPreparedTorrent({ attemptId: reserved.attemptId,
    candidate, hash: prepared.expected.hash, nowMs });
  if (bound.state === 'held') return bound;
  const plan = ledger.recordFilePlan({ attemptId: reserved.attemptId,
    hash: prepared.expected.hash, plannedFiles: selectedFiles, nowMs });
  if (plan.state !== 'planned') return plan;
  let selectedBonuses = ledger.getRecordedBonusPlan?.(reserved.attemptId);
  if (!selectedBonuses && typeof ledger.recordBonusPlan === 'function') {
    const fresh=await refreshBonusOwnership({files:bonus.bonusFiles,readOwnership:readBonusOwnership});
    selectedBonuses=ledger.recordBonusPlan({attemptId:reserved.attemptId,hash:prepared.expected.hash,files:fresh.files,nowMs:now()});
  }
  if(selectedBonuses?.state==='held')return selectedBonuses;
  const bonusFiles=selectedBonuses?.files??[];
  return submitStoppedCandidate({ ...activeQbittorrent, ledger,
    attemptId: reserved.attemptId, candidate, prepared, nowMs,
    plannedFileNames: [...selectedFiles,...bonusFiles].map((file) => file.name) });
}
