import { commitProvisionalShokoLink } from './commit-provisional-shoko-link.mjs';
import { observeProvisionalImport } from './observe-provisional-import.mjs';
import { planProvisionalShokoLinks } from './plan-provisional-shoko-links.mjs';

const held = (reason) => ({ state: 'held', reason });

// One bounded, retryable operation for a published provisional handoff.
// A successful result proves Shoko identity only; public Plex availability
// is established by the separate file availability worker.
export async function processProvisionalShokoLinkAttempt({ attemptId,
  shokoImportRoot, readHandoff, readAttempt, readRequest, loadDetail,
  readAliases = async () => [], readRelatedTitles, readImportedFile,
  previewRelease, saveRelease, nowMs = Date.now(),
  minNativeWaitMs = 30 * 60_000, allowUserLink = false } = {}) {
  if (!Number.isSafeInteger(attemptId) || attemptId < 1 ||
      !Number.isSafeInteger(nowMs) || nowMs < 0 ||
      !Number.isSafeInteger(minNativeWaitMs) || minNativeWaitMs < 60_000 ||
      typeof allowUserLink !== 'boolean' ||
      [readHandoff, readAttempt, readRequest, loadDetail, readAliases,
        readRelatedTitles, readImportedFile, previewRelease, saveRelease]
        .some((fn) => typeof fn !== 'function')) {
    throw new TypeError('Invalid provisional link processor');
  }
  let handoff, attempt, request, detail, aliases, related, observedFiles;
  try {
    handoff = await readHandoff(attemptId);
    attempt = await readAttempt(attemptId);
    request = attempt ? await readRequest(attempt.requestId) : null;
    if (handoff?.status !== 'published_observed' ||
        handoff.manifest?.identity !== 'provisional' || !attempt || !request) {
      return held('provisional_handoff_unavailable');
    }
    const anidbId = handoff.manifest.anidbId;
    [detail, aliases, related] = await Promise.all([
      loadDetail({ anidbId }), readAliases({ anidbId }),
      readRelatedTitles({ anidbId }),
    ]);
    observedFiles = [];
    for (const file of handoff.manifest.videos) {
      observedFiles.push(await readImportedFile({ ed2k: file.ed2k,
        size: file.size, includeAbsolutePaths: true }));
    }
  } catch { return held('shoko_link_evidence_unavailable'); }
  if (observedFiles.some((file) => file?.state === 'not_imported')) {
    return held('shoko_import_pending');
  }
  const planned = planProvisionalShokoLinks({ handoff, attempt, request,
    detail, aliases, related, observedFiles, shokoImportRoot });
  if (planned.state !== 'links_ready') return planned;
  // An unrecognized Shoko row can be transient while native providers run.
  // An absent, future, or recent import time must never trigger a User link.
  for (const link of planned.links) {
    const observed = observedFiles.find((file) => file?.fileId === link.fileId);
    if (!Number.isSafeInteger(observed?.importedAtMs) ||
        observed.importedAtMs < 0 ||
        nowMs - observed.importedAtMs < minNativeWaitMs) {
      return held('shoko_native_match_pending');
    }
  }
  // A filename-derived User release is not the routine fallback. The
  // installed Shoko Offline Importer can supply provider identity, but its
  // automatic rules must be verified separately before enabling this path.
  if (planned.links.length > 0 && !allowUserLink) {
    return held('shoko_fallback_pending');
  }
  for (const link of planned.links) {
    const result = await commitProvisionalShokoLink({ plan: link,
      readImportedFile, previewRelease, saveRelease });
    if (result.state !== 'shoko_link_verified') return result;
  }
  return observeProvisionalImport({ handoff, readImportedFile });
}
