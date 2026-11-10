const held = (reason) => ({ state: 'held', reason });

// A filename preview is an independent Shoko episode prediction, not an
// AniDB file registration or proof that the staged bytes contain that episode.
export function evaluateOfflinePreview(preview, expected) {
  if (!Number.isSafeInteger(expected?.animeId) || expected.animeId < 1 ||
      !Array.isArray(expected.episodeIds) || expected.episodeIds.length !== 1 ||
      !Number.isSafeInteger(expected.episodeIds[0]) ||
      expected.episodeIds[0] < 1 ||
      typeof expected.filename !== 'string' ||
      expected.filename.length < 1 || expected.filename.length > 255 ||
      /[\\/\0\r\n]/.test(expected.filename)) {
    throw new TypeError('Invalid expected offline identity');
  }
  if (preview?.status === 204) return held('offline_lookup_inconclusive');
  if (preview?.status !== 200) return held('provider_unavailable');
  const release = preview.release;
  if (release?.ProviderName !== 'Offline Importer' ||
      release.IsCorrupted !== false ||
      !Array.isArray(release.CrossReferences) ||
      release.CrossReferences.length !== 1 ||
      release.CrossReferences[0]?.PercentageStart !== 0 ||
      release.CrossReferences[0]?.PercentageEnd !== 100 ||
      !Number.isSafeInteger(release.CrossReferences[0]?.AnidbAnimeID) ||
      !Number.isSafeInteger(release.CrossReferences[0]?.AnidbEpisodeID)) {
    return held('invalid_offline_evidence');
  }
  const releaseId = `offline://${expected.animeId}-${expected.episodeIds[0]}`;
  const ref = release.CrossReferences[0];
  if (release.ID !== releaseId ||
      release.OriginalFilename !== expected.filename ||
      ref.AnidbAnimeID !== expected.animeId ||
      ref.AnidbEpisodeID !== expected.episodeIds[0]) {
    return { state: 'rejected', reason: 'wrong_identity' };
  }
  return { state: 'accepted', reason: 'exact_shoko_offline_link',
    releaseId, coverage: [{ episodeId: ref.AnidbEpisodeID,
      start: 0, end: 100 }] };
}
