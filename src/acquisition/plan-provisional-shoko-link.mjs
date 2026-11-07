import path from 'node:path';
import { evaluateHandoffEvidence } from './handoff-evidence.mjs';
import { checkRelatedInstallment } from './related-installment-guard.mjs';
import { matchesTrustedReleaseTitle, planTorrentTargets } from './plan-torrent-targets.mjs';
import { trustedReleaseQueries } from './trusted-release-queries.mjs';

const held = (reason) => ({ state: 'held', reason });
const validId = (value) => Number.isSafeInteger(value) && value > 0;

// This is only a plan for a possible Shoko User release. It checks the saved
// release choice against fresh Shoko catalogue and relation data and requires
// Shoko's exact unrecognized bytes at Negev's owned Import location. The
// caller must re-read Shoko before any write and verify Plex afterward.
export function planProvisionalShokoLink({ handoff, attempt, request, detail,
  related, aliases = [], observed, shokoImportRoot } = {}) {
  if (typeof attempt?.candidateTitle !== 'string' ||
      !attempt.candidateTitle.trim() || attempt.candidateTitle.length > 500) {
    return held('release_title_unavailable');
  }
  const manifest = handoff?.manifest;
  const evidence = evaluateHandoffEvidence({ identity: manifest?.identity,
    version: manifest?.version, anidbId: manifest?.anidbId,
    torrentHash: manifest?.torrentHash, files: manifest?.videos,
    subtitles: manifest?.subtitles });
  if (handoff?.status !== 'published_observed' ||
      evidence.state !== 'valid' || evidence.digest !== handoff.evidenceDigest ||
      JSON.stringify(evidence.manifest) !== JSON.stringify(manifest) ||
      manifest.identity !== 'provisional' || manifest.videos.length !== 1 ||
      manifest.videos[0].episodeIds.length !== 1 || !validId(attempt?.id) ||
      attempt.status !== 'torrent_observed' ||
      attempt.requestId !== request?.id ||
      attempt.anidbId !== manifest.anidbId ||
      attempt.torrentHash !== manifest.torrentHash ||
      JSON.stringify(attempt.episodeIds) !==
        JSON.stringify(manifest.videos[0].episodeIds) ||
      request?.anidbId !== manifest.anidbId ||
      handoff.publishName !==
        `negev-${attempt.id}-${evidence.digest.slice(0, 16)}`) {
    return held('handoff_evidence_mismatch');
  }
  const file = manifest.videos[0];
  const parts = file.name.split('/');
  if (typeof shokoImportRoot !== 'string' ||
      !path.posix.isAbsolute(shokoImportRoot) ||
      shokoImportRoot === '/' ||
      path.posix.normalize(shokoImportRoot) !== shokoImportRoot ||
      /[\0\r\n\\]/.test(shokoImportRoot) ||
      parts.some((part) => !part || part === '.' || part === '..') ||
      file.name.includes('\\')) return held('unsafe_import_path');
  if (observed?.state !== 'imported_unrecognized' ||
      !validId(observed.fileId) || observed.ed2k !== file.ed2k ||
      observed.size !== file.size || !Array.isArray(observed.locations) ||
      observed.locations.length > 100) return held('shoko_file_unverified');
  const expectedPath = path.posix.join(shokoImportRoot,
    handoff.publishName, ...parts);
  if (!observed.locations.some((location) =>
    validId(location?.managedFolderId) && location.accessible === true &&
    location.path === expectedPath)) return held('shoko_file_not_owned');

  if (!Array.isArray(aliases) || aliases.length > 10) {
    return held('catalogue_title_unavailable');
  }
  const trustedTitle = trustedReleaseQueries(detail?.title, aliases).find((title) =>
    matchesTrustedReleaseTitle(attempt.candidateTitle, title));
  if (!trustedTitle) return held('release_title_mismatch');
  const relatedCheck = checkRelatedInstallment({ anidbId: manifest.anidbId,
    requestedTitle: detail.title, related,
    releaseTitle: attempt.candidateTitle, fileNames: [file.name] });
  if (relatedCheck.state !== 'related_title_clear') return relatedCheck;
  const planned = planTorrentTargets({ request, detail,
    prepared: { state: 'prepared_stopped', files: [{
      name: file.name, size: file.size }] },
    releaseTitle: attempt.candidateTitle, trustedTitle });
  if (planned.state !== 'planned_targets' ||
      planned.plannedFiles.length !== 1 ||
      JSON.stringify(planned.plannedFiles[0].episodeIds) !==
        JSON.stringify(file.episodeIds)) {
    return held(planned.reason ?? 'episode_plan_mismatch');
  }
  return { state: 'link_ready', fileId: observed.fileId,
    anidbId: manifest.anidbId, episodeId: file.episodeIds[0],
    ed2k: file.ed2k, size: file.size,
    evidenceDigest: evidence.digest, ownedPath: expectedPath };
}
