export function summarizeSeasonAvailability({ kind, episodes, nextPage }) {
  if (kind !== 'series' || !Array.isArray(episodes)) return null;
  const regular = episodes.filter((episode) => episode.type === 'Episode');
  return { verified: regular.filter((episode) =>
    episode.availability === 'available').length,
  total: regular.length, completeList: nextPage === null };
}

export function titleAvailabilitySummary({ kind, episodes, nextPage,
  regularSeason, verifiedTitleItems = 0 }) {
  const pageCount = episodes.filter((episode) =>
    episode.availability === 'available').length;
  const titleHasProof = verifiedTitleItems > 0 || pageCount > 0;
  if (kind === 'movie') {
    const film = summarizeFilmAvailability({ kind, episodes, nextPage });
    if (film.available) return {
      text: `Available in Plex · ${film.verified} verified main film entr${film.verified === 1 ? 'y' : 'ies'}. Other editions and extras are separate.`,
      available: true };
    if (titleHasProof) return {
      text: 'Some items for this title are verified playable in Plex. A main film entry is not confirmed on this page.',
      available: false };
    if (film.total > 0) return {
      text: film.completeList
        ? 'No main film entry is currently verified playable in Plex. This does not establish that it is missing.'
        : 'No main film entry on this page is verified playable in Plex. More entries remain to load.',
      available: false };
  }
  if (kind === 'series') {
    const validFull = Number.isSafeInteger(regularSeason?.total) &&
      Number.isSafeInteger(regularSeason?.verified) &&
      regularSeason.total > 0 && regularSeason.verified >= 0 &&
      regularSeason.verified <= regularSeason.total;
    const season = validFull ? regularSeason :
      summarizeSeasonAvailability({ kind, episodes, nextPage });
    if (season?.total > 0) return {
      text: validFull || season.completeList
        ? `${season.verified} of ${season.total} regular episodes verified playable in Plex. Specials are separate.`
        : `${season.verified} regular episodes on this page verified playable in Plex. More episodes remain to load.`,
      available: season.verified > 0 };
    if (titleHasProof) return {
      text: 'Some items for this title are verified playable in Plex. Regular-season availability is not confirmed yet; Specials are separate.',
      available: false };
  }
  return { text: 'Current Plex availability has not been verified for this title.',
    available: false };
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
  monitorFuture = false, regularSeason = null }) {
  if (kind === 'movie') return summarizeFilmAvailability({ kind, episodes, nextPage })?.available
    ? 'already_available' : 'requestable';
  if (monitorFuture === true) return 'requestable';
  if (kind === 'series' && Number.isSafeInteger(regularSeason?.total) &&
      regularSeason.total > 0 &&
      regularSeason.verified === regularSeason.total) return 'already_available';
  const season = summarizeSeasonAvailability({ kind, episodes, nextPage });
  return season?.completeList && season.total > 0 && season.verified === season.total
    ? 'already_available' : 'requestable';
}

export function filmEntryRequestState({ episodes, nextPage, selectedId }) {
  if (installmentRequestState({ kind: 'movie', episodes, nextPage }) ===
      'already_available') return 'already_available';
  const selected = episodes?.find((episode) => episode.id === selectedId);
  return selected?.type === 'Episode' && selected.availability !== 'available'
    ? 'requestable' : 'entry_unavailable';
}
