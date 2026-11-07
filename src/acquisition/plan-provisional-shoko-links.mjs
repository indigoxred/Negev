import path from 'node:path';
import { evaluateHandoffEvidence } from './handoff-evidence.mjs';
import { checkRelatedInstallment } from './related-installment-guard.mjs';
import { matchesTrustedReleaseTitle, planTorrentTargets } from './plan-torrent-targets.mjs';
import { trustedReleaseQueries } from './trusted-release-queries.mjs';

const held = (reason) => ({ state: 'held', reason });
const validId = (value) => Number.isSafeInteger(value) && value > 0;
const sameIds = (left, right) => Array.isArray(left) &&
  left.length === right.length &&
  JSON.stringify([...left].sort((a, b) => a - b)) ===
    JSON.stringify([...right].sort((a, b) => a - b));

// Plans only. A caller must re-read Shoko before each supported save and
// separately verify all final Shoko locations and public Plex playback.
export function planProvisionalShokoLinks({ handoff, attempt, request, detail,
  related, aliases = [], observedFiles, shokoImportRoot } = {}) {
  const manifest = handoff?.manifest;
  const evidence = evaluateHandoffEvidence({ identity: manifest?.identity,
    version: manifest?.version, anidbId: manifest?.anidbId,
    torrentHash: manifest?.torrentHash, files: manifest?.videos,
    subtitles: manifest?.subtitles });
  if (handoff?.status !== 'published_observed' ||
      evidence.state !== 'valid' || evidence.digest !== handoff.evidenceDigest ||
      JSON.stringify(evidence.manifest) !== JSON.stringify(manifest) ||
      manifest.identity !== 'provisional' ||
      !validId(attempt?.id) || attempt.status !== 'torrent_observed' ||
      attempt.requestId !== request?.id ||
      attempt.anidbId !== manifest.anidbId ||
      attempt.torrentHash !== manifest.torrentHash ||
      request?.anidbId !== manifest.anidbId ||
      !sameIds(attempt.episodeIds,
        manifest.videos.flatMap((file) => file.episodeIds)) ||
      handoff.publishName !==
        `negev-${attempt.id}-${evidence.digest.slice(0, 16)}`) {
    return held('handoff_evidence_mismatch');
  }
  if (typeof attempt.candidateTitle !== 'string' ||
      !attempt.candidateTitle.trim() || attempt.candidateTitle.length > 500) {
    return held('release_title_unavailable');
  }
  if (typeof shokoImportRoot !== 'string' ||
      !path.posix.isAbsolute(shokoImportRoot) || shokoImportRoot === '/' ||
      path.posix.normalize(shokoImportRoot) !== shokoImportRoot ||
      /[\0\r\n\\]/.test(shokoImportRoot) ||
      manifest.videos.some((file) => file.name.includes('\\') ||
        file.name.split('/').some((part) => !part || part === '.' || part === '..'))) {
    return held('unsafe_import_path');
  }
  if (!Array.isArray(aliases) || aliases.length > 10) {
    return held('catalogue_title_unavailable');
  }
  if (typeof detail?.title !== 'string' || !detail.title.trim()) {
    return held('catalogue_title_unavailable');
  }
  const trustedTitle = trustedReleaseQueries(detail?.title, aliases).find((title) =>
    matchesTrustedReleaseTitle(attempt.candidateTitle, title));
  if (!trustedTitle) return held('release_title_mismatch');
  const relatedCheck = checkRelatedInstallment({ anidbId: manifest.anidbId,
    requestedTitle: detail.title, related, releaseTitle: attempt.candidateTitle,
    fileNames: manifest.videos.map((file) => file.name) });
  if (relatedCheck.state !== 'related_title_clear') return relatedCheck;
  const planned = planTorrentTargets({ request, detail,
    prepared: { state: 'prepared_stopped', files: manifest.videos.map((file) =>
      ({ name: file.name, size: file.size })) },
    releaseTitle: attempt.candidateTitle, trustedTitle });
  if (planned.state !== 'planned_targets' ||
      planned.plannedFiles.length !== manifest.videos.length ||
      manifest.videos.some((file) => !planned.plannedFiles.some((candidate) =>
        candidate.name === file.name && candidate.size === file.size &&
        sameIds(candidate.episodeIds, file.episodeIds)))) {
    return held(planned.reason ?? 'episode_plan_mismatch');
  }
  if (!Array.isArray(observedFiles) ||
      observedFiles.length !== manifest.videos.length) {
    return held('shoko_file_unverified');
  }
  const links = [];
  const identifiedFileIds = [];
  for (const file of manifest.videos) {
    const matching = observedFiles.filter((observed) =>
      observed?.ed2k === file.ed2k && observed.size === file.size);
    if (matching.length !== 1) return held('shoko_file_unverified');
    const observed = matching[0];
    if (!validId(observed.fileId) || identifiedFileIds.includes(observed.fileId)) {
      return held('shoko_file_unverified');
    }
    identifiedFileIds.push(observed.fileId);
    if (observed.state === 'imported_recognized') {
      const refs = observed.release?.crossReferences;
      if (observed.release?.isCorrupted !== false || !Array.isArray(refs) ||
          refs.length !== file.episodeIds.length ||
          !file.episodeIds.every((episodeId) => refs.some((ref) =>
            ref?.animeId === manifest.anidbId &&
            ref.episodeId === episodeId && ref.start === 0 && ref.end === 100))) {
        return held('shoko_identity_conflict');
      }
      continue;
    }
    // Only Shoko can assign multi-episode coverage. Retry its native match
    // later; never synthesize a combined release from the torrent name.
    if (file.episodeIds.length !== 1) return held('shoko_native_match_pending');
    if (observed.state !== 'imported_unrecognized' ||
        !Array.isArray(observed.locations) || observed.locations.length > 100) {
      return held('shoko_file_unverified');
    }
    const ownedPath = path.posix.join(shokoImportRoot,
      handoff.publishName, ...file.name.split('/'));
    if (!observed.locations.some((location) =>
      validId(location?.managedFolderId) && location.accessible === true &&
      location.path === ownedPath)) return held('shoko_file_not_owned');
    links.push({ state: 'link_ready', fileId: observed.fileId,
      anidbId: manifest.anidbId, episodeId: file.episodeIds[0],
      ed2k: file.ed2k, size: file.size,
      evidenceDigest: evidence.digest, ownedPath });
  }
  return { state: 'links_ready', links, identifiedFileIds };
}
