// Shoko's AniDB EpisodeCount is the expected number of normal episodes,
// excluding Specials. An unknown or incomplete count cannot close a watch.
export function hasStatedRegularEpisodes(detail) {
  return Number.isSafeInteger(detail?.episodeCount) &&
    detail.episodeCount > 0 && Array.isArray(detail.episodes) &&
    detail.episodes.filter((episode) => episode?.type === 'Episode').length >=
      detail.episodeCount;
}
