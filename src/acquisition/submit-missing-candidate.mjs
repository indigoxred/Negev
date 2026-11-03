import { prepareStoppedCandidate } from './prepare-stopped-candidate.mjs';
import { reserveMissingTargets } from './reserve-missing-targets.mjs';
import { submitStoppedCandidate } from './submit-stopped-candidate.mjs';
import { torrentFileKind } from './evaluate-stopped-manifest.mjs';
import { matchesTrustedReleaseTitle, planTorrentTargets } from './plan-torrent-targets.mjs';
import { isCompleteAniDbDetail } from '../catalogue/hydration-ledger.mjs';
import { trustedReleaseQueries } from './trusted-release-queries.mjs';

const held = (reason) => ({ state: 'held', reason });

function exactFilePlan(prepared, plannedFiles, episodeIds) {
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
  const videos = prepared.files.filter((file) => torrentFileKind(file.name) === 'video');
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
  readEvidence, publicLibraryIds, ledger,
  firstTimePolicy = 'strict', now = Date.now, prowlarr, qbittorrent }) {
  if (!prowlarr || !qbittorrent || typeof now !== 'function' ||
      typeof releaseQueries !== 'function' ||
      !['strict', 'single_uncertain_attempt'].includes(firstTimePolicy) ||
      (expectedHash !== undefined &&
        (typeof expectedHash !== 'string' ||
        !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(expectedHash)))) {
    throw new TypeError('Invalid stopped acquisition configuration');
  }
  if (!isCompleteAniDbDetail(detail, request?.anidbId) ||
      detail.kind !== request.kind) return held('detail_unavailable');
  if (detail.restricted !== false) return held('restricted_or_unverified');
  const catalogueIds = new Set(detail.episodes.map((episode) => episode.id));
  if (!Array.isArray(request.episodeIds) || request.episodeIds.length === 0 ||
      request.episodeIds.some((id) => !catalogueIds.has(id))) {
    return held('target_missing');
  }
  // Request preflight searches the canonical AniDB title but omits the
  // query from its response. Reconstruct that same trusted query here rather
  // than relying on a global Prowlarr query that the runtime does not set.
  let selectedQuery = trustedReleaseQueries(detail.title)[0];
  if (searchQuery !== undefined) {
    let aliases;
    try { aliases = await releaseQueries({ anidbId: request.anidbId }); }
    catch { return held('trusted_query_unavailable'); }
    if (!trustedReleaseQueries(detail.title, aliases).includes(searchQuery)) {
      return held('untrusted_release_query');
    }
    selectedQuery = searchQuery;
  }
  if (!selectedQuery) return held('untrusted_release_query');
  if (!matchesTrustedReleaseTitle(candidate?.title, selectedQuery,
    detail.title)) return held('release_title_mismatch');
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
  if (expectedHash !== undefined &&
      prepared.expected.hash.toLowerCase() !== expectedHash.toLowerCase()) {
    return held('preflight_torrent_changed');
  }
  if ((episodeIds !== undefined || plannedFiles !== undefined) &&
      !exactFilePlan(prepared, plannedFiles, episodeIds)) {
    return held('file_plan_mismatch');
  }
  // Re-derive the episode map even when a caller supplies a reviewed plan.
  // The final server boundary cannot trust stale or forged preflight fields.
  const mapped = planTorrentTargets({ request, detail, prepared,
    releaseTitle: candidate.title, trustedTitle: selectedQuery });
  if (mapped.state !== 'planned_targets') return mapped;
  const selectedEpisodeIds = episodeIds ?? mapped.episodeIds;
  const selectedFiles = plannedFiles ?? mapped.plannedFiles;
  if (!exactFilePlan(prepared, selectedFiles, selectedEpisodeIds)) return held('file_plan_mismatch');
  const mappedByName = new Map(mapped.plannedFiles.map((file) =>
    [file.name, file.episodeIds]));
  if (selectedFiles.some((file) => JSON.stringify([...file.episodeIds]
    .sort((a, b) => a - b)) !== JSON.stringify(mappedByName.get(file.name)))) {
    return held('file_plan_mismatch');
  }
  const reserved = await reserveMissingTargets({ request, candidate, episodeIds: selectedEpisodeIds,
    readEvidence, publicLibraryIds, ledger, firstTimePolicy, now });
  if (!['reserved', 'existing'].includes(reserved.state)) return reserved;
  const nowMs = now();
  const bound = ledger.bindPreparedTorrent({ attemptId: reserved.attemptId,
    candidate, hash: prepared.expected.hash, nowMs });
  if (bound.state === 'held') return bound;
  const plan = ledger.recordFilePlan({ attemptId: reserved.attemptId,
    hash: prepared.expected.hash, plannedFiles: selectedFiles, nowMs });
  if (plan.state !== 'planned') return plan;
  return submitStoppedCandidate({ ...qbittorrent, ledger,
    attemptId: reserved.attemptId, candidate, prepared, nowMs });
}
