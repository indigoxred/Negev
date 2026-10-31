import { scanShokoRecentSince } from './shoko-recent-catchup.mjs';

const held = (reason) => ({ state: 'held', reason });

// Explicit ticks only. The file-ID queue is durable and later IDs can run
// while an unavailable file waits for its own retry. No server timer uses it.
export function createShokoRecentWorker({ ledger, readPage, refreshFile,
  now = Date.now, pageSize = 100, maxPages = 5 } = {}) {
  if (typeof ledger?.getCursor !== 'function' ||
      typeof ledger?.recordBatch !== 'function' ||
      typeof ledger?.nextDue !== 'function' ||
      typeof ledger?.recordResult !== 'function' ||
      typeof readPage !== 'function' || typeof refreshFile !== 'function' ||
      typeof now !== 'function' || !Number.isSafeInteger(pageSize) ||
      pageSize < 1 || pageSize > 100 || !Number.isSafeInteger(maxPages) ||
      maxPages < 1 || maxPages > 5) {
    throw new TypeError('Invalid recent Shoko worker');
  }
  let busy = false;
  return {
    async scan() {
      if (busy) return held('recent_worker_busy');
      busy = true;
      try {
        const since = ledger.getCursor();
        if (!since) return held('recent_baseline_required');
        const batch = await scanShokoRecentSince({ readPage, since,
          pageSize, maxPages });
        if (batch.state !== 'complete') return batch;
        const saved = ledger.recordBatch(batch);
        return saved.state === 'recorded' ? { state: 'caught_up',
          added: saved.added } : saved;
      } catch { return held('recent_scan_unavailable'); }
      finally { busy = false; }
    },
    async drainOne() {
      if (busy) return held('recent_worker_busy');
      busy = true;
      try {
        const pending = ledger.nextDue(now());
        if (!pending) return { state: 'idle' };
        let result;
        try { result = await refreshFile(pending.fileId); }
        catch { result = { state: 'unavailable' }; }
        const saved = ledger.recordResult({ fileId: pending.fileId,
          success: result?.state === 'recorded_file', nowMs: now() });
        return { ...saved, fileId: pending.fileId };
      } catch { return held('recent_work_unavailable'); }
      finally { busy = false; }
    },
  };
}
