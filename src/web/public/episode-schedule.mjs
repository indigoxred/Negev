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
  const next = regular.filter((episode) =>
    fullDate(episode.airDate) && episode.airDate >= asOf &&
    (episode.airDate > asOf || !verifiedIds.has(episode.id)))
    .sort((a, b) => a.airDate.localeCompare(b.airDate) ||
      a.number - b.number)[0];
  return { aired, upcoming, undated: regular.length - aired - upcoming,
    verifiedAired,
    total: regular.length, asOf,
    nextAirDate: next?.airDate ?? null,
    nextEpisodeNumber: next?.number ?? null };
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

export function nextAirDateLabel({ kind, releaseState, releaseStatus, schedule } = {}) {
  // Catalogue presentation can establish completion while request handling
  // conservatively keeps an incomplete episode roster open for monitoring.
  if (kind !== 'series' || releaseState !== 'airing' ||
      typeof releaseStatus === 'string' && releaseStatus.toLowerCase() === 'finished') return null;
  if (!fullDate(schedule?.nextAirDate)) return 'Next air date unknown';
  const number = Number.isSafeInteger(schedule.nextEpisodeNumber) &&
    schedule.nextEpisodeNumber > 0 ? `${schedule.nextEpisodeNumber} · ` : '';
  return `Next scheduled episode: ${number}${schedule.nextAirDate}`;
}

// Request monitoring is distinct from tracking and from a finished watch.
export function watchingNextAirLabel(item) {
  if (item?.status !== 'held' || item.kind !== 'series' ||
      item.monitorFuture !== true || item.watchClosed === true) return null;
  const schedule = item.nextAir;
  if (!fullDate(schedule?.nextAirDate)) return 'Next air date unknown';
  const number = Number.isSafeInteger(schedule.nextEpisodeNumber) &&
    schedule.nextEpisodeNumber > 0 ? `Episode ${schedule.nextEpisodeNumber} · ` : '';
  return `Next: ${number}${schedule.nextAirDate}`;
}
