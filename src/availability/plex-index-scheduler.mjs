const validId = (value) => Number.isSafeInteger(value) && value > 0;
const held = (reason) => ({ state: 'held', reason });

// Opt-in, single-flight scheduler. It starts after one full interval, never
// reads more than one bounded page per tick, and periodically revisits the
// newest page so a long backfill does not hide a new Plex arrival for days.
export function createPlexIndexScheduler({ sections, tickPage, tickRecent,
  intervalMs = 60_000, recentEvery = 10,
  hasRecentArrival = () => false, burstIntervalMs = 15_000 } = {}) {
  if (!sections || !['episode', 'movie'].every((kind) =>
    Array.isArray(sections[kind]) && sections[kind].length <= 20 &&
    sections[kind].every(validId) &&
    new Set(sections[kind]).size === sections[kind].length) ||
      sections.episode.length + sections.movie.length === 0 ||
      typeof tickPage !== 'function' || typeof tickRecent !== 'function' ||
      !Number.isSafeInteger(intervalMs) || intervalMs < 15_000 ||
      intervalMs > 300_000 ||
      typeof hasRecentArrival !== 'function' ||
      !Number.isSafeInteger(burstIntervalMs) || burstIntervalMs < 15_000 ||
      burstIntervalMs > intervalMs ||
      !Number.isSafeInteger(recentEvery) || recentEvery < 2 || recentEvery > 100) {
    throw new TypeError('Invalid Plex index scheduler');
  }
  const sources = [
    ...sections.episode.map((libraryId) => ({ kind: 'episode', libraryId })),
    ...sections.movie.map((libraryId) => ({ kind: 'movie', libraryId })),
  ];
  let timer;
  let inFlight;
  let running = false;
  let closed = false;
  let position = 0;
  const visits = sources.map(() => 0);
  const recentOffsets = sources.map(() => 0);
  const runOnce = async () => {
    if (closed) return held('scheduler_closed');
    if (inFlight) return held('scheduler_busy');
    const current = position;
    const source = sources[current];
    position = (position + 1) % sources.length;
    const burst = hasRecentArrival();
    if (!burst) visits[current]++;
    const action = burst || visits[current] % recentEvery === 0 ? tickRecent : tickPage;
    const input = burst ? { ...source, offset: recentOffsets[current] } : source;
    inFlight = Promise.resolve().then(() => action(input));
    try {
      const result = await inFlight;
      if (burst && result?.state === 'page_indexed') {
        recentOffsets[current] = result.nextOffset === 0 ? 0 :
          recentOffsets[current] >= 10 ? 0 : recentOffsets[current] + 5;
      }
      return result;
    }
    catch { return held('plex_index_unavailable'); }
    finally { inFlight = null; }
  };
  const schedule = () => {
    if (closed || !running) return;
    timer = setTimeout(() => {
      void runOnce().finally(schedule);
    }, hasRecentArrival() ? burstIntervalMs : intervalMs);
  };
  return {
    runOnce,
    start() {
      if (closed || running) return;
      running = true;
      schedule();
    },
    async close() {
      closed = true;
      running = false;
      clearTimeout(timer);
      if (inFlight) await Promise.allSettled([inFlight]);
    },
  };
}
