import { reconcileParentWatch } from './parent-watch-reconcile.mjs';

const held = (reason) => ({ state: 'held', reason });

// One TVDB parent per tick; both provider reads and ledger writes are bounded.
// A provider failure does not advance the durable cursor or release ownership.
export function createParentWatchWorker({ parents, requests, mapReader,
  loadDetail, readRelations, today, now = Date.now,
  reconcile = reconcileParentWatch } = {}) {
  if (typeof parents?.getCursor !== 'function' ||
      typeof parents?.listActive !== 'function' ||
      typeof parents?.advanceCursor !== 'function' ||
      typeof mapReader?.read !== 'function' ||
      typeof loadDetail !== 'function' ||
      typeof readRelations !== 'function' ||
      typeof today !== 'function' || typeof now !== 'function' ||
      typeof reconcile !== 'function' || !requests) {
    throw new TypeError('Invalid parent watch worker');
  }
  return {
    async runOnce() {
      const afterId = parents.getCursor();
      const page = parents.listActive({ afterTvdbId: afterId, limit: 1 });
      if (!Array.isArray(page) || page.length > 1) return held('parent_page_invalid');
      if (page.length === 0) {
        const advanced = parents.advanceCursor({ expectedTvdbId: afterId,
          nextTvdbId: 0 });
        return advanced.state === 'advanced' ? { state: 'page', afterId: 0 }
          : advanced;
      }
      const parent = page[0];
      if (!Number.isSafeInteger(parent?.tvdbId) || parent.tvdbId <= afterId) {
        return held('parent_page_invalid');
      }
      let map;
      try { map = await mapReader.read(); }
      catch { return held('parent_map_unavailable'); }
      let result;
      try {
        result = await reconcile({ parent, map, parents, requests,
          loadDetail, readRelations, today: today(), nowMs: now() });
      } catch { return held('parent_reconcile_failed'); }
      if (result?.state !== 'reconciled') return result ?? held('parent_reconcile_failed');
      const advanced = parents.advanceCursor({ expectedTvdbId: afterId,
        nextTvdbId: parent.tvdbId });
      return advanced.state === 'advanced'
        ? { state: 'page', afterId: parent.tvdbId, result } : advanced;
    },
  };
}
