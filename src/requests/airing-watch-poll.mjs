import { isCompleteAniDbDetail } from '../catalogue/hydration-ledger.mjs';
import { inferReleaseState } from '../catalogue/infer-release-state.mjs';
import { airingCheckCadence } from './airing-check-cadence.mjs';

const held = (reason) => ({ state: 'held', reason });
const validId = (value) => Number.isSafeInteger(value) && value > 0;

// One paced, read-only catalogue poll for a bounded page of durable Airing
// watches. The request ledger is the only writer. No download is dispatched.
export async function pollAiringWatches({ ledger, loadDetail, today,
  afterId = 0, limit = 3, intervalMs = 1_000, requestId = null,
  expectedEpisodeNumbers = [], hydrateMetadata = null, nowMs = Date.now(),
  adultAllowed = null } = {}) {
  if (typeof ledger?.listActiveAirings !== 'function' ||
      typeof ledger?.advanceAiring !== 'function' ||
      typeof loadDetail !== 'function' ||
      (requestId !== null && !validId(requestId)) ||
      !Array.isArray(expectedEpisodeNumbers) || expectedEpisodeNumbers.length > 32 ||
      expectedEpisodeNumbers.some(n => !validId(n) || n > 9999) ||
      (hydrateMetadata !== null && typeof hydrateMetadata !== 'function') ||
      (adultAllowed !== null && typeof adultAllowed !== 'function') ||
      !Number.isSafeInteger(afterId) || afterId < 0 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 10 ||
      !Number.isSafeInteger(intervalMs) || intervalMs < 0 || intervalMs > 10_000 ||
      !Number.isSafeInteger(nowMs) || nowMs < 0 ||
      typeof today !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(today)) {
    throw new TypeError('Invalid Airing poll configuration');
  }
  if (requestId !== null) { afterId=requestId-1; limit=1; }
  const page = ledger.listActiveAirings({ afterId, limit, nowMs,
    ...(requestId === null ? {} : {requestId}) });
  const watches = requestId === null || !Array.isArray(page) ? page :
    page.filter(watch => watch.requestId === requestId);
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
    if (!isCompleteAniDbDetail(detail, watch.anidbId, { allowEmptySeries: true }) ||
        detail.kind !== 'series' ||
        detail.episodes.length > 2_000) {
      results.push({ ...watch, ...held('detail_incomplete') });
      continue;
    }
    const missingNumber = expectedEpisodeNumbers.find(number => !detail.episodes.some(
      episode => episode.type === 'Episode' && Number(episode.number) === number));
    if (missingNumber !== undefined) {
      try { await hydrateMetadata?.({anidbId:watch.anidbId,missingEpisodeNumber:missingNumber}); }
      catch { /* Retain the durable watch deadline for later provider recovery. */ }
      results.push({...watch,...held('episode_metadata_pending')});
      continue;
    }
    if (expectedEpisodeNumbers.length && hydrateMetadata) {
      try { await hydrateMetadata({anidbId:watch.anidbId,
        missingEpisodeNumber:expectedEpisodeNumbers[0]}); }
      catch { /* Existing complete metadata still permits the ordinary watch advance. */ }
    }
    if (typeof detail.restricted !== 'boolean') {
      results.push({ ...watch, ...held('restricted_or_unverified') });
      continue;
    }
    // A watch keeps adding episodes in the background, so it must re-check the
    // owner's 18+ access each time, as a new request would. Access can be
    // turned off, or a title reclassified, after the watch was saved.
    if (detail.restricted && adultAllowed) {
      let allowed = false;
      try { allowed = await adultAllowed({ requesterId: watch.requesterId }) === true; }
      catch { allowed = false; }
      if (!allowed) {
        results.push({ ...watch, ...held('adult_access_disabled') });
        continue;
      }
    }
    const release = inferReleaseState({ today, kind: detail.kind,
      airDate: detail.airDate, endDate: detail.endDate,
      episodeCount: detail.episodeCount, episodes: detail.episodes });
    if (!['airing', 'upcoming', 'completed'].includes(release.state)) {
      results.push({ ...watch, ...held('release_state_unknown') });
      continue;
    }
    // AniDB episode-count inference may say Completed before a series has an
    // explicit end date. Continue adding aired episodes, but leave watch open.
    const completionUnconfirmed = release.state === 'completed' && detail.endDate == null;
    const state = completionUnconfirmed || release.state === 'upcoming'
      ? 'airing' : release.state;
    let advanced;
    try {
      advanced = ledger.advanceAiring({ requestId: watch.requestId,
        detail, releaseState: state, today });
    } catch {
      results.push({ ...watch, ...held('watch_write_unavailable') });
      continue;
    }
    if (advanced?.state === 'advanced' && !advanced.watchClosed &&
        typeof ledger.recordAiringTiming === 'function') {
      const cadence = airingCheckCadence({ today, state:
        release.state === 'upcoming' ? 'upcoming' : 'airing',
      airDate: detail.airDate, episodes: detail.episodes });
      try {
        ledger.recordAiringTiming({ requestId: watch.requestId, nowMs,
          nextMetadataMs: nowMs + cadence.metadataMs,
          feedIntervalMs: cadence.feedMs });
      } catch {
        results.push({ ...watch, ...held('watch_timing_unavailable') });
        continue;
      }
    }
    results.push({ ...watch, ...advanced,
      ...(completionUnconfirmed ? { reason: 'completion_unconfirmed' } : {}) });
  }
  return { state: 'page', results,
    nextAfterId: watches.length === limit ? watches.at(-1).requestId : null };
}
