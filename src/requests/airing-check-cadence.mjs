const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const fullDate = (value) => typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
const earliestDate = (value) => {
  if (fullDate(value)) return value;
  if (typeof value === 'string' && /^\d{4}$/.test(value)) return `${value}-01-01`;
  if (typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    return `${value}-01`;
  }
  return null;
};

// This only sets shared read frequency. It does not assert an episode aired or
// make an indexer hit eligible for download.
export function airingCheckCadence({ today, state, airDate, episodes = [] } = {}) {
  if (!fullDate(today) || !['upcoming', 'airing'].includes(state) ||
      !Array.isArray(episodes)) throw new TypeError('Invalid Airing cadence');
  if (state === 'airing') return { metadataMs: HOUR, feedMs: HOUR };
  const expected = [airDate, ...episodes.filter((episode) =>
    episode?.type === 'Episode').map((episode) => episode.airDate)]
    .map(earliestDate).filter((date) => date !== null && date >= today).sort()[0];
  if (!expected) return { metadataMs: DAY, feedMs: 6 * HOUR };
  const days = (Date.parse(`${expected}T00:00:00Z`) -
    Date.parse(`${today}T00:00:00Z`)) / DAY;
  if (days <= 2) return { metadataMs: HOUR, feedMs: HOUR };
  if (days <= 30) return { metadataMs: DAY, feedMs: 6 * HOUR };
  return { metadataMs: Math.min(7 * DAY, (days - 30) * DAY), feedMs: DAY };
}
