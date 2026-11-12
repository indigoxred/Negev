import { openParentWatchLedger } from './parent-watch-ledger.mjs';
import { openRequestLedger } from './request-ledger.mjs';
import { createParentWatchWorker } from './parent-watch-worker.mjs';
import { createVerifiedAniMapReader } from '../acquisition/verified-animap-reader.mjs';
import { createAiringScheduler } from './airing-scheduler.mjs';
import { collectAniDbDetail } from '../catalogue/collect-detail.mjs';
import { loadAniDbDetail } from '../catalogue/shoko-detail.mjs';
import { createAniMapRawDetailReader } from '../catalogue/animap-raw-detail.mjs';
import { readAniDbRelatedTitles as readShokoRelations } from
  '../catalogue/shoko-related-titles.mjs';
import { readAniDbRelatedTitles as readArchiveRelations } from
  '../catalogue/anidb-related-titles.mjs';
import { dateInZone } from '../web/user-server-config.mjs';

export function mergeParentRelations(anidbId, local, archive) {
  const valid = (value) => value?.state === 'related_titles' &&
    value.anidbId === anidbId && Array.isArray(value.items) &&
    value.items.length <= 50 && value.items.every((item) =>
      Number.isSafeInteger(item?.anidbId) && item.anidbId > 0 &&
      typeof item.relation === 'string');
  const sources = [archive, local].filter(valid);
  if (sources.length === 0) return { state: 'unavailable' };
  const items = new Map();
  for (const source of sources) {
    for (const item of source.items) {
      const previous = items.get(item.anidbId);
      if (previous && previous.relation !== item.relation) {
        return { state: 'unavailable' };
      }
      items.set(item.anidbId, item);
    }
  }
  return items.size <= 50
    ? { state: 'related_titles', anidbId, items: [...items.values()] }
    : { state: 'unavailable' };
}

// Runs only after an explicit service opt-in. Every tick handles at most one
// adopted TVDB parent, and this component never starts an acquisition itself.
export function startParentWatchRuntime({ config, shokoApiKey,
  openParents = openParentWatchLedger,
  openRequests = openRequestLedger,
  createWorker = createParentWatchWorker,
  createScheduler = createAiringScheduler,
  createMapReader = createVerifiedAniMapReader,
  createArchiveReader = createAniMapRawDetailReader,
  fetchImpl = fetch } = {}) {
  if (config?.parentWatch !== true) return null;
  if (typeof config.dbPath !== 'string' ||
      typeof config.shokoBaseUrl !== 'string' ||
      typeof config.timeZone !== 'string' ||
      typeof shokoApiKey !== 'string' || !shokoApiKey) {
    throw new TypeError('Parent watch configuration unavailable');
  }
  let parents;
  let requests;
  let scheduler;
  try {
    parents = openParents(config.dbPath);
    requests = openRequests(config.dbPath);
    const archive = createArchiveReader({ fetchImpl });
    const readDetail = async ({ anidbId }) => {
      const first = await loadAniDbDetail({
        baseUrl: config.shokoBaseUrl, apiKey: shokoApiKey,
        anidbId, page: 1, fetchImpl, timeoutMs: 5_000 });
      const useShoko = first.state === 'details';
      return collectAniDbDetail({ anidbId, loadPage: ({ page }) =>
        useShoko ? page === 1 ? first : loadAniDbDetail({
          baseUrl: config.shokoBaseUrl, apiKey: shokoApiKey,
          anidbId, page, fetchImpl, timeoutMs: 5_000 })
          : archive.read({ anidbId, page }) });
    };
    const readRelations = async (anidbId) => {
      const [local, archiveRelations] = await Promise.all([
        readShokoRelations({
          baseUrl: config.shokoBaseUrl, apiKey: shokoApiKey,
          anidbId, fetchImpl, timeoutMs: 5_000 }),
        readArchiveRelations({ anidbId, titleForId: () => null,
          fetchImpl, timeoutMs: 5_000 }),
      ]);
      return mergeParentRelations(anidbId, local, archiveRelations);
    };
    const worker = createWorker({ parents, requests,
      mapReader: createMapReader({ fetchImpl }), loadDetail: readDetail,
      readRelations,
      today: () => dateInZone(config.timeZone) });
    scheduler = createScheduler({ runPage: worker.runOnce,
      initialDelayMs: 120_000, pageDelayMs: 60_000,
      cycleDelayMs: 86_400_000, failureDelayMs: 300_000 });
    scheduler.start();
  } catch (error) {
    requests?.close(); parents?.close();
    throw error;
  }
  return { async close() {
    await scheduler.stop();
    parents.close(); requests.close();
  } };
}
