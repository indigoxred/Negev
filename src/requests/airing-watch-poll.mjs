import { isCompleteAniDbDetail } from '../catalogue/hydration-ledger.mjs';
import { inferReleaseState } from '../catalogue/infer-release-state.mjs';

const held = (reason) => ({ state: 'held', reason });
const validId = (value) => Number.isSafeInteger(value) && value > 0;

// One paced, read-only catalogue poll for a bounded page of durable Airing
// watches. The request ledger is the only writer. No download is dispatched.
export async function pollAiringWatches({ ledger, loadDetail, today,
  afterId = 0, limit = 3, intervalMs = 1_000 } = {}) {
  if (typeof ledger?.listActiveAirings !== 'function' ||
      typeof ledger?.advanceAiring !== 'function' ||
      typeof loadDetail !== 'function' ||
      !Number.isSafeInteger(afterId) || afterId < 0 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 10 ||
      !Number.isSafeInteger(intervalMs) || intervalMs < 0 || intervalMs > 10_000 ||
      typeof today !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(today)) {
    throw new TypeError('Invalid Airing poll configuration');
  }
  const watches = ledger.listActiveAirings({ afterId, limit });
  if (!Array.isArray(watches) || watches.length > limit ||
      watches.some((item, index) => !validId(item?.requestId) ||
        item.requestId <= (index === 0 ? afterId : watches[index - 1].requestId) ||
        !validId(item.anidbId))) return held('invalid_watch_page');
  const results = [];
  const detailCache = new Map();
  let reads = 0;
  for (const watch of watches) {
    let detail;
    if (detailCache.has(watch.anidbId)) detail = detailCache.get(watch.anidbId);
    else {
      if (reads > 0 && intervalMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
      reads++;
      try { detail = await loadDetail({ anidbId: watch.anidbId }); }
      catch { detail = { state: 'unavailable' }; }
      detailCache.set(watch.anidbId, detail);
    }
    if (!isCompleteAniDbDetail(detail, watch.anidbId) || detail.kind !== 'series' ||
        detail.episodes.length > 2_000) {
      results.push({ ...watch, ...held('detail_incomplete') });
      continue;
    }
    const release = inferReleaseState({ today, kind: detail.kind,
      airDate: detail.airDate, endDate: detail.endDate,
      episodeCount: detail.episodeCount, episodes: detail.episodes });
    if (!['airing', 'completed'].includes(release.state)) {
      results.push({ ...watch, ...held('release_state_unknown') });
      continue;
    }
    // AniDB episode-count inference may say Completed before a series has an
    // explicit end date. Continue adding aired episodes, but leave watch open.
    const completionUnconfirmed = release.state === 'completed' && detail.endDate == null;
    const state = completionUnconfirmed ? 'airing' : release.state;
    const advanced = ledger.advanceAiring({ requestId: watch.requestId,
      detail, releaseState: state, today });
    results.push({ ...watch, ...advanced,
      ...(completionUnconfirmed ? { reason: 'completion_unconfirmed' } : {}) });
  }
  return { state: 'page', results,
    nextAfterId: watches.length === limit ? watches.at(-1).requestId : null };
}
