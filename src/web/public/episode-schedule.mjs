const fullDate = (value) => typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

export function regularEpisodeSchedule({ episodes, asOf, verifiedIds = new Set() }) {
  if (!Array.isArray(episodes) || !fullDate(asOf)) return null;
  const regular = episodes.filter((episode) => episode.type === 'Episode');
  const upcoming = regular.filter((episode) =>
    fullDate(episode.airDate) && episode.airDate > asOf).length;
  const aired = regular.filter((episode) =>
    fullDate(episode.airDate) && episode.airDate <= asOf).length;
  const verifiedAired = regular.filter((episode) =>
    fullDate(episode.airDate) && episode.airDate <= asOf &&
    verifiedIds.has(episode.id)).length;
  return { aired, upcoming, undated: regular.length - aired - upcoming,
    verifiedAired,
    total: regular.length, asOf };
}

export function episodeScheduleLabel(episode, asOf) {
  if (episode?.type !== 'Episode' || !fullDate(asOf)) return '';
  const untitled = !episode.title?.trim() ||
    episode.title.trim().toLowerCase() === `episode ${episode.number}`;
  if (fullDate(episode.airDate) && episode.airDate > asOf) return `Upcoming · scheduled ${episode.airDate}${untitled ? ' · title not published yet' : ''}`;
  if (!fullDate(episode.airDate)) return untitled
    ? 'Air date and title not published yet' : 'Air date not published yet';
  return untitled ? 'Aired · title not published yet' : 'Aired';
}
