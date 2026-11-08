export function summarizeSeasonAvailability({ kind, episodes, nextPage }) {
  if (kind !== 'series' || !Array.isArray(episodes)) return null;
  const regular = episodes.filter((episode) => episode.type === 'Episode');
  return { verified: regular.filter((episode) =>
    episode.availability === 'available').length,
  total: regular.length, completeList: nextPage === null };
}

export function summarizeFilmAvailability({ kind, episodes, nextPage }) {
  if (kind !== 'movie' || !Array.isArray(episodes)) return null;
  const main = episodes.filter((episode) => episode.type === 'Episode');
  const verified = main.filter((episode) =>
    episode.availability === 'available').length;
  return { verified, total: main.length,
    completeList: nextPage === null, available: verified > 0 };
}

export function installmentRequestState({ kind, episodes, nextPage,
  monitorFuture = false }) {
  if (kind === 'movie') return summarizeFilmAvailability({ kind, episodes, nextPage })?.available
    ? 'already_available' : 'requestable';
  if (monitorFuture === true) return 'requestable';
  const season = summarizeSeasonAvailability({ kind, episodes, nextPage });
  return season?.completeList && season.total > 0 && season.verified === season.total
    ? 'already_available' : 'requestable';
}
