const validId = (value) => Number.isSafeInteger(value) && value > 0;
const held = (reason) => ({ state: 'held', reason });

// An empty exact-GUID query is useful first-acquisition evidence, but Plex
// may contain a card under another agent identity. Never call it absence.
export async function probeFirstTimePublicCards({ kind, episodeIds,
  tmdbMovieIds = [], publicSections, readGuidCards } = {}) {
  const episodes = publicSections?.episode;
  const movies = publicSections?.movie;
  if (!['series', 'movie'].includes(kind) ||
      !Array.isArray(episodeIds) || episodeIds.length < 1 ||
      episodeIds.length > 20 || episodeIds.some((id) => !validId(id)) ||
      new Set(episodeIds).size !== episodeIds.length ||
      !Array.isArray(episodes) || !Array.isArray(movies) ||
      episodes.length + movies.length < 1 ||
      episodes.length + movies.length > 4 ||
      [...episodes, ...movies].some((id) => !validId(id)) ||
      new Set([...episodes, ...movies]).size !== episodes.length + movies.length ||
      typeof readGuidCards !== 'function' ||
      !Array.isArray(tmdbMovieIds) || tmdbMovieIds.length > 4 ||
      tmdbMovieIds.some((id) => !validId(id)) ||
      new Set(tmdbMovieIds).size !== tmdbMovieIds.length) {
    throw new TypeError('Invalid first-time Plex probe');
  }
  if (kind === 'series' && episodes.length === 0) {
    return held('public_library_unconfigured');
  }
  if (kind === 'movie' && movies.length && tmdbMovieIds.length === 0) {
    return held('movie_identity_unverified');
  }
  const queries = [];
  for (const episodeId of episodeIds) {
    for (const libraryId of episodes) {
      queries.push({ libraryId, kind: 'episode',
        guid: `tv.plex.agents.custom.shoko://episode/e${episodeId}` });
    }
  }
  if (kind === 'movie') {
    for (const tmdbId of tmdbMovieIds) {
      for (const libraryId of movies) {
        queries.push({ libraryId, kind: 'movie', guid: `tmdb://${tmdbId}` });
      }
    }
  }
  // Keep a first-time request from turning into an unbounded Plex sweep.
  if (queries.length > 40) return held('public_probe_too_broad');
  for (const query of queries) {
    let result;
    try { result = await readGuidCards(query); }
    catch { return held('public_probe_unavailable'); }
    if (result?.state !== 'cards' || result.complete !== true ||
        !Array.isArray(result.cards) || result.cards.length > 10) {
      return held('public_probe_unavailable');
    }
    if (result.cards.length) return held('public_card_observed');
  }
  return { state: 'healthy_unconfirmed',
    libraryIds: kind === 'movie' ? [...episodes, ...movies] : [...episodes],
    parts: [], complete: false };
}
