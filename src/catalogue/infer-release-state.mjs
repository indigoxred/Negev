const unknown = { state: 'unknown', confidence: 'none' };
const inferred = (state) => ({ state, confidence: 'inferred' });

function parsePartialDate(value, full = false) {
  if (typeof value !== 'string' || !/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(value) ||
      (full && value.length !== 10)) return null;
  const [year, rawMonth, rawDay] = value.split('-').map(Number);
  if (year < 1 || year > 9999 || (rawMonth !== undefined && (rawMonth < 1 || rawMonth > 12))) return null;
  const month = rawMonth ?? 12;
  const d = new Date(0);
  d.setUTCFullYear(year, month, 0);
  const maxDay = d.getUTCDate();
  if (rawDay !== undefined && (rawDay < 1 || rawDay > maxDay)) return null;
  const first = `${String(year).padStart(4, '0')}-${String(rawMonth ?? 1).padStart(2, '0')}-${String(rawDay ?? 1).padStart(2, '0')}`;
  const last = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(rawDay ?? maxDay).padStart(2, '0')}`;
  return { first, last };
}

// Mirrors Shoko's documented inference at a conservative data boundary. AniDB
// cannot distinguish a hiatus or cancellation from an ongoing release.
export function inferReleaseState({ today, kind, airDate, endDate = null, episodeCount = null, episodes } = {}) {
  const current = parsePartialDate(today, true);
  const start = parsePartialDate(airDate);
  const end = endDate === null ? null : parsePartialDate(endDate);
  if (!current || !start || (endDate !== null && !end) ||
      (end && end.last < start.first) ||
      !['series', 'movie'].includes(kind) || !Array.isArray(episodes) ||
      (episodeCount !== null && (!Number.isSafeInteger(episodeCount) || episodeCount < 0))) return unknown;
  if (end && episodes.some((episode) => episode?.type === 'Episode' &&
      episode.airDate != null &&
      (!parsePartialDate(episode.airDate) ||
        parsePartialDate(episode.airDate).first > end.last))) return unknown;
  if (end && end.last <= current.last) return inferred('completed');
  // An exact episode date inside a partial start interval is stronger
  // evidence than the interval's latest possible day.
  if (start.last > current.last) {
    const airedWithinStart = episodes.some((episode) => {
      if (episode?.type !== 'Episode') return false;
      const date = parsePartialDate(episode.airDate, true);
      return date && date.first >= start.first &&
        date.last <= start.last && date.last <= current.last;
    });
    if (!airedWithinStart) return inferred('upcoming');
  }
  if (end) return inferred(end.last <= current.last ? 'completed' : 'airing');
  if (kind === 'movie') return inferred('completed');
  const normal = episodes.filter((episode) => episode?.type === 'Episode');
  if (episodeCount > 0 && normal.length >= episodeCount &&
      normal.every((episode) => {
        const date = parsePartialDate(episode.airDate, true);
        return date && date.last <= current.last;
      })) return inferred('completed');
  return inferred('airing');
}
