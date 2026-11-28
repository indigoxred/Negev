import { scanShokoRecentSince } from './shoko-recent-catchup.mjs';
import { scanShokoFileIdsSince } from './shoko-fileid-catchup.mjs';

import { heldReporter } from '../runtime/held-diagnostics.mjs';
const held = (reason) => ({ state: 'held', reason });
const heldAfter = heldReporter('availability/shoko-recent-worker');

// Explicit ticks only. The file-ID queue is durable and later IDs can run
// while an unavailable file waits for its own retry. The refresh callback must
// report recognition='linked' before a file leaves the queue: Shoko can first
// list an import as provisional and link it after hashing. No server timer uses it.
export function createShokoRecentWorker({ ledger, readPage, readFileIdPage,
  isKnownFileId = () => false, refreshFile, isRetirementCurrent = () => false,
  now = Date.now, pageSize = 100, maxPages = 5 } = {}) {
  if (typeof ledger?.getCursor !== 'function' ||
      typeof ledger?.getCapacity !== 'function' ||
      typeof ledger?.recordBatch !== 'function' ||
      typeof ledger?.nextDue !== 'function' ||
      typeof ledger?.recordResult !== 'function' ||
      typeof readPage !== 'function' || typeof refreshFile !== 'function' ||
      (readFileIdPage !== undefined && (typeof readFileIdPage !== 'function' ||
        typeof ledger?.getFileIdCursor !== 'function' ||
        typeof ledger?.recordFileIdBatch !== 'function')) ||
      typeof isKnownFileId !== 'function' || typeof isRetirementCurrent !== 'function' ||
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
        if (!since) return heldAfter(new Error('Initialize once with node src/availability/init-recent-baseline.mjs --init'), 'recent_baseline_required');
        const capacity = ledger.getCapacity();
        if (!Number.isSafeInteger(capacity?.pending) || capacity.pending < 0 ||
            !Number.isSafeInteger(capacity.maxPending) || capacity.maxPending < 1 ||
            capacity.pending >= capacity.maxPending) {
          return held('recent_backlog_full');
        }
        const batch = await scanShokoRecentSince({ readPage, since,
          pageSize, maxPages, continuation: ledger.getContinuation?.('timestamp') });
        if (batch.restart) ledger.clearContinuation?.('timestamp');
        const saved = batch.state === 'continuing' || batch.resumed
          ? ledger.recordScanBatch('timestamp', batch) : batch.state === 'complete' ? ledger.recordBatch(batch) : batch;
        let fileIdSaved = { state: 'recorded', added: 0 };
        if (readFileIdPage) {
          const fileIdBatch = await scanShokoFileIdsSince({
            readPage: readFileIdPage, sinceId: ledger.getFileIdCursor(),
            pageSize, maxPages, continuation: ledger.getContinuation?.('fileid') });
          if (fileIdBatch.restart) ledger.clearContinuation?.('fileid');
          if (!['complete', 'continuing'].includes(fileIdBatch.state)) fileIdSaved = fileIdBatch;
          else {
            const pendingFileIds = fileIdBatch.fileIds.filter((id) =>
              !isKnownFileId(id));
            fileIdSaved = fileIdBatch.state === 'continuing' || fileIdBatch.resumed
              ? ledger.recordScanBatch('fileid', { ...fileIdBatch, pendingFileIds })
              : ledger.recordFileIdBatch({ ...fileIdBatch, pendingFileIds });
          }
        }
        if (fileIdSaved.state !== 'recorded') return fileIdSaved;
        if (saved.state !== 'recorded') return saved;
        return { state: 'caught_up', added: saved.added + fileIdSaved.added };
      } catch (error) { return heldAfter(error, 'recent_scan_unavailable'); }
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
        let retirement;
        if(result?.state==='missing_file' && result.fileId===pending.fileId){
          let confirmed;
          try{confirmed=await refreshFile(pending.fileId);}catch{confirmed=null;}
          if(confirmed?.state==='recorded_file')result=confirmed;
          if(confirmed?.state==='missing_file' && confirmed.fileId===pending.fileId &&
              Number.isSafeInteger(result.generation) && result.generation>=0 &&
              (result.observedRevision===null || Number.isSafeInteger(result.observedRevision)) &&
              confirmed.generation===result.generation && confirmed.observedRevision===result.observedRevision &&
              isRetirementCurrent(confirmed)===true)retirement='removed';
        }
        if(result?.state==='recorded_file' && result.recognition==='unverified' && result.fileId===pending.fileId && isRetirementCurrent(result)===true) retirement='unsupported_links';
        if(retirement && typeof ledger.retirePending==='function')return {...ledger.retirePending({fileId:pending.fileId,reason:retirement,nowMs:now()}),fileId:pending.fileId};
        const saved = ledger.recordResult({ fileId: pending.fileId,
          success: result?.state === 'recorded_file' &&
            result.recognition === 'linked', nowMs: now() });
        return { ...saved, fileId: pending.fileId };
      } catch (error) { return heldAfter(error, 'recent_work_unavailable'); }
      finally { busy = false; }
    },
  };
}
