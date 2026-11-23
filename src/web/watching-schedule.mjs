import { regularEpisodeSchedule } from './public/episode-schedule.mjs';

const isWatching = item => item?.status === 'held' && item.kind === 'series' &&
  item.monitorFuture === true && item.watchClosed !== true;

// Presentation only: use the shared archive cache, never await a provider from
// the Requests route or invoke availability/import/acquisition work here.
export function createWatchingScheduleReader({ cachedIndex, readDetail, today,
  verifiedIds = () => new Set(), now = Date.now, maxPending = 20 }) {
  const pending = new Set(), cooldown = new Map();
  return {
    // Exact cached request scope, not evidence that a release exists or aired.
    // Never wait for a provider or change the saved acquisition targets here.
    pendingToday(item, availableEpisodeIds) {
      if (!isWatching(item) || !Array.isArray(item.episodeIds) ||
          item.episodeIds.length < 1 || new Set(item.episodeIds).size !== item.episodeIds.length ||
          !Array.isArray(availableEpisodeIds) ||
          new Set(availableEpisodeIds).size !== availableEpisodeIds.length ||
          availableEpisodeIds.some(id => !item.episodeIds.includes(id))) return null;
      const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        Number.isFinite(Date.parse(value+'T00:00:00Z')) &&
        new Date(value+'T00:00:00Z').toISOString().slice(0,10) === value;
      const asOf = today(), episodes = cachedIndex(item.anidbId)?.regularEpisodes;
      if (!validDate(asOf) || !Array.isArray(episodes)) return null;
      const byId = new Map(episodes.filter(e => e.type === 'Episode').map(e => [e.id,e]));
      const selected = item.episodeIds.map(id => byId.get(id));
      if (selected.some(e => !e || !validDate(e.airDate) || e.airDate > asOf)) return null;
      const available = new Set(availableEpisodeIds);
      const pending = selected.filter(e => !available.has(e.id));
      if (!pending.length || pending.some(e => e.airDate !== asOf ||
          !Number.isSafeInteger(e.number) || e.number < 1)) return null;
      return { asOf, targetCount: item.episodeIds.length, verifiedTargets: available.size,
        pendingEpisodeNumbers: pending.map(e => e.number).sort((a,b) => a-b) };
    },
    read(item) {
      if (!isWatching(item)) return null;
      const index = cachedIndex(item.anidbId);
      if (index) {
        const schedule = regularEpisodeSchedule({ episodes: index.regularEpisodes,
          asOf: today(), verifiedIds: verifiedIds(item.anidbId) });
        return schedule ? { nextAirDate: schedule.nextAirDate,
          nextEpisodeNumber: schedule.nextEpisodeNumber } : null;
      }
      if (!pending.has(item.anidbId) && pending.size < maxPending &&
          (cooldown.get(item.anidbId) ?? 0) <= now()) {
        pending.add(item.anidbId);
        // Bound repeat unknown/failure lookups independently of request polling.
        cooldown.delete(item.anidbId);
        cooldown.set(item.anidbId, now() + 60_000);
        while (cooldown.size > 100) cooldown.delete(cooldown.keys().next().value);
        try {
          void Promise.resolve(readDetail({ anidbId: item.anidbId, page: 1 }))
            .catch(() => {}).finally(() => pending.delete(item.anidbId));
        } catch { pending.delete(item.anidbId); }
      }
      return null;
    },
  };
}
