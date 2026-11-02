const validId = (value) => Number.isSafeInteger(value) && value > 0;
const validEpisode = (episode) => validId(episode?.id) &&
  validId(episode.number) && typeof episode.type === 'string' &&
  typeof episode.title === 'string';

// The page is only a browsing aid. The request API still reloads every
// catalogue page and checks each exact AniDB episode before saving intent.
export function createEpisodePager(first) {
  if (first?.state !== 'details' || first.page !== 1 ||
      !validId(first.anidbId) || typeof first.title !== 'string' ||
      !['series', 'movie'].includes(first.kind) ||
      !Number.isSafeInteger(first.total) || first.total < 0 ||
      !Array.isArray(first.episodes) ||
      (first.episodes.length === 0 && first.total !== 0) ||
      first.episodes.length > first.total ||
      first.episodes.some((episode) => !validEpisode(episode)) ||
      new Set(first.episodes.map((episode) => episode.id)).size !== first.episodes.length ||
      (first.nextPage !== null && first.nextPage !== 2) ||
      (first.nextPage === null) !== (first.episodes.length === first.total)) {
    throw new TypeError('Invalid first episode page');
  }
  const episodes = [...first.episodes];
  const ids = new Set(episodes.map((episode) => episode.id));
  let nextPage = first.nextPage;
  return {
    get episodes() { return [...episodes]; },
    get nextPage() { return nextPage; },
    append(page) {
      if (nextPage === null || page?.state !== 'details' ||
          page.anidbId !== first.anidbId || page.title !== first.title ||
          page.kind !== first.kind || page.total !== first.total ||
          page.restricted !== first.restricted ||
          page.page !== nextPage ||
          !Array.isArray(page.episodes) || page.episodes.length < 1 ||
          episodes.length + page.episodes.length > first.total ||
          page.episodes.some((episode) => !validEpisode(episode) || ids.has(episode.id)) ||
          new Set(page.episodes.map((episode) => episode.id)).size !== page.episodes.length ||
          (page.nextPage !== null && page.nextPage !== nextPage + 1) ||
          (page.nextPage === null) !==
            (episodes.length + page.episodes.length === first.total)) {
        return { state: 'held' };
      }
      for (const episode of page.episodes) {
        episodes.push(episode);
        ids.add(episode.id);
      }
      nextPage = page.nextPage;
      return { state: 'appended', episodes: [...page.episodes] };
    },
  };
}
