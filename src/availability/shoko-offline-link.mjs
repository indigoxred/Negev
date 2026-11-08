// Shoko's Offline Importer can link a first-time release before AniDB has a
// file record. This proves only Shoko's scoped episode link. Public playback
// still requires the separate exact Plex card and same-file check.
export function exactShokoOfflineLink(release, anidbId, episodeId) {
  const ref = release?.CrossReferences?.[0];
  return Number.isSafeInteger(anidbId) && anidbId > 0 &&
    Number.isSafeInteger(episodeId) && episodeId > 0 &&
    release?.ProviderName === 'Offline Importer' &&
    release.ID === `offline://${anidbId}-${episodeId}` &&
    release.IsCorrupted === false &&
    Array.isArray(release.CrossReferences) &&
    release.CrossReferences.length === 1 &&
    ref?.AnidbAnimeID === anidbId && ref.AnidbEpisodeID === episodeId &&
    ref.PercentageStart === 0 && ref.PercentageEnd === 100;
}
