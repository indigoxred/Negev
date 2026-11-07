export function summarizeSeasonAvailability({ kind, episodes, nextPage }) {
  if (kind !== 'series' || !Array.isArray(episodes)) return null;
  const regular = episodes.filter((episode) => episode.type === 'Episode');
  return { verified: regular.filter((episode) =>
    episode.availability === 'available').length,
  total: regular.length, completeList: nextPage === null };
}
