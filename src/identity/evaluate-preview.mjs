const held = (reason) => ({ state: 'held', reason });

// Only the installed Shoko AniDB provider's release shape is accepted here.
// This function is deliberately independent of network and import operations.
export function evaluatePreview(preview, expected) {
  // Shoko also emits 204 while its AniDB provider is banned; HTTP status
  // alone cannot prove the release is absent from AniDB.
  if (preview?.status === 204) return held('lookup_inconclusive');
  if (preview?.status !== 200) return held('provider_unavailable');

  const raw = preview.release;
  const pascal = raw && Object.hasOwn(raw, 'ProviderName');
  const release = pascal ? {
    id: raw.ID,
    providerName: raw.ProviderName,
    releaseURI: raw.ReleaseURI,
    fileSize: raw.FileSize,
    hashes: Array.isArray(raw.Hashes) ? raw.Hashes.map((hash) => ({ type: hash?.Type, value: hash?.Value })) : null,
    crossReferences: Array.isArray(raw.CrossReferences) ? raw.CrossReferences.map((xref) => ({
      anidbAnimeID: xref?.AnidbAnimeID,
      anidbEpisodeID: xref?.AnidbEpisodeID,
    })) : null,
  } : raw;
  const digest = expected?.ed2k;
  const size = expected?.size;
  if (!/^[0-9A-F]{32}$/.test(digest) || !Number.isSafeInteger(size) || size <= 0 ||
      !Number.isSafeInteger(expected.animeId) || expected.animeId <= 0 ||
      !Array.isArray(expected.episodeIds) || expected.episodeIds.length === 0 ||
      expected.episodeIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new TypeError('Invalid expected AniDB identity');
  }

  const fileMatch = /^https:\/\/anidb\.net\/file\/([1-9][0-9]*)$/.exec(release?.releaseURI);
  if (release?.providerName !== 'AniDB' ||
      release.id !== `anidb://${digest}+${size}` ||
      release.fileSize !== size ||
      !fileMatch || !Number.isSafeInteger(Number(fileMatch[1])) ||
      !Array.isArray(release.hashes) ||
      !release.hashes.some((hash) => hash?.type === 'ED2K' && hash.value === digest) ||
      !Array.isArray(release.crossReferences) || release.crossReferences.length === 0 ||
      release.crossReferences.some((xref) =>
        !Number.isSafeInteger(xref?.anidbAnimeID) || xref.anidbAnimeID <= 0 ||
        !Number.isSafeInteger(xref?.anidbEpisodeID) || xref.anidbEpisodeID <= 0)) {
    return held('invalid_response');
  }

  const actual = release.crossReferences.map((xref) => `${xref.anidbAnimeID}:${xref.anidbEpisodeID}`);
  const wanted = expected.episodeIds.map((id) => `${expected.animeId}:${id}`);
  if (new Set(actual).size !== actual.length ||
      actual.length !== wanted.length ||
      actual.some((id) => !wanted.includes(id))) {
    return { state: 'rejected', reason: 'wrong_identity' };
  }

  return { state: 'accepted', reason: 'exact_anidb_release', fileId: Number(fileMatch[1]) };
}
