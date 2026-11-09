const held = (reason) => ({ state: 'held', reason });
const validId = (value) => Number.isSafeInteger(value) && value > 0;
const sameIds = (left, right) => Array.isArray(left) &&
  left.length === right.length && left.every((id) => right.includes(id));

// This check runs after the source bytes have been verified but before a
// private holding copy is made. It protects the new Offline Importer fallback
// from repeating an exact prior import, even if Shoko later recognizes those
// same bytes through a different release provider. AniDB-registered first
// imports retain their existing route, including titles whose local Shoko
// episode does not exist yet.
export async function checkExistingShokoBatch({ verified, readEpisode } = {}) {
  if (verified?.state !== 'batch_identity_verified' ||
      !validId(verified.anidbId) || !Array.isArray(verified.files) ||
      verified.files.length < 1 || verified.files.length > 100 ||
      typeof readEpisode !== 'function') {
    throw new TypeError('Invalid existing Shoko batch check');
  }
  const offlineFiles = verified.files.filter((file) =>
    file?.identitySource === 'shoko_offline');
  if (offlineFiles.length === 0) return { state: 'no_matching_import' };
  const episodes = new Map();
  let imported = 0;
  for (const expected of offlineFiles) {
    if (!Array.isArray(expected.episodeIds) || expected.episodeIds.length < 1 ||
        expected.episodeIds.length > 100 ||
        !expected.episodeIds.every(validId)) return held('invalid_file_evidence');
    let matching = null;
    for (const episodeId of expected.episodeIds) {
      if (!episodes.has(episodeId)) {
        let result;
        try { result = await readEpisode({ anidbId: verified.anidbId, episodeId }); }
        catch { return held('shoko_unavailable'); }
        if (result?.state !== 'not_imported' &&
            (result?.state !== 'ok' || result.complete !== true ||
              !Array.isArray(result.files) || result.files.length > 50)) {
          return held('shoko_unavailable');
        }
        episodes.set(episodeId, result);
      }
      const result = episodes.get(episodeId);
      const candidates = result.state === 'not_imported' ? [] : result.files.filter((file) =>
        file?.anidbId === verified.anidbId && file.ed2k === expected.ed2k &&
        file.size === expected.size && validId(file.fileId) &&
        sameIds(file.episodeIds, expected.episodeIds) &&
        Array.isArray(file.sourcePaths) && file.sourcePaths.length > 0 &&
        expected.episodeIds.every((id) => file.coverage?.some((range) =>
          range.episodeId === id && range.start === 0 && range.end === 100)));
      if (candidates.length > 1) return held('ambiguous_shoko_file');
      if (candidates.length === 0) { matching = null; break; }
      if (matching !== null && matching !== candidates[0].fileId) {
        return held('inconsistent_shoko_file');
      }
      matching = candidates[0].fileId;
    }
    if (matching !== null) imported++;
  }
  if (imported > 0) return held(imported === offlineFiles.length
    ? 'already_imported' : 'partial_existing_import');
  return { state: 'no_matching_import' };
}
