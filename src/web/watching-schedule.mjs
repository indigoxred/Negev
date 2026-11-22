import { regularEpisodeSchedule } from './public/episode-schedule.mjs';

const isWatching = item => item?.status === 'held' && item.kind === 'series' &&
  item.monitorFuture === true && item.watchClosed !== true;

// Presentation only: use the shared archive cache, never await a provider from
// the Requests route or invoke availability/import/acquisition work here.
export function createWatchingScheduleReader({ cachedIndex, readDetail, today,
  verifiedIds = () => new Set(), now = Date.now, maxPending = 20 }) {
  const pending = new Set(), cooldown = new Map();
  return {
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
