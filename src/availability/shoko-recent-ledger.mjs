import { DatabaseSync } from 'node:sqlite';

const held = (reason) => ({ state: 'held', reason });
const emptyCursor = { fileId: 1, importedNs: '0' };
const validId = (value) => Number.isSafeInteger(value) && value > 0;
const validCursor = (value) => validId(value?.fileId) &&
  typeof value.importedNs === 'string' && /^[0-9]{1,22}$/.test(value.importedNs) &&
  (BigInt(value.importedNs) > 0n ||
    (value.fileId === emptyCursor.fileId && value.importedNs === '0'));
export const recentBaselineState = cursor => cursor == null ? 'required' : validCursor(cursor) ? 'ready' : 'invalid';
const compare = (left, right) => {
  const a = BigInt(left.importedNs);
  const b = BigInt(right.importedNs);
  return a < b ? -1 : a > b ? 1 :
    left.fileId < right.fileId ? -1 : left.fileId > right.fileId ? 1 : 0;
};

// Recent imports are positive IDs awaiting exact Shoko rechecks. The cursor
// and pending queue share one SQLite transaction: no caught-up file is lost
// if the process stops between the two writes.
export function openShokoRecentLedger(dbPath, { maxPending = 32_768 } = {}) {
  if (typeof dbPath !== 'string' || !dbPath || dbPath === ':memory:' ||
      !Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 32_768) {
    throw new TypeError('Invalid recent Shoko ledger');
  }
  const db = new DatabaseSync(dbPath, { timeout: 5_000 });
  try {
    db.exec('PRAGMA journal_mode=WAL');
    db.exec(`CREATE TABLE IF NOT EXISTS shoko_recent_cursor (
      id INTEGER PRIMARY KEY CHECK(id=1),
      imported_ns TEXT NOT NULL,
      file_id INTEGER NOT NULL CHECK(file_id>0)
    ) STRICT`);
    db.exec(`CREATE TABLE IF NOT EXISTS shoko_recent_pending (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER NOT NULL UNIQUE CHECK(file_id>0),
      retry_after_ms INTEGER NOT NULL DEFAULT 0 CHECK(retry_after_ms>=0)
    ) STRICT`);
    db.exec(`CREATE TABLE IF NOT EXISTS shoko_recent_drain_state (
      id INTEGER PRIMARY KEY CHECK(id=1),
      prefer_retry INTEGER NOT NULL CHECK(prefer_retry IN (0,1))
    ) STRICT`);
    db.exec('INSERT INTO shoko_recent_drain_state VALUES (1,1) ON CONFLICT(id) DO NOTHING');
    db.exec(`CREATE TABLE IF NOT EXISTS shoko_recent_continuation (kind TEXT PRIMARY KEY, payload TEXT NOT NULL) STRICT`);
    db.exec(`CREATE TABLE IF NOT EXISTS shoko_recent_retirements (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,file_id INTEGER NOT NULL CHECK(file_id>0),
      reason TEXT NOT NULL CHECK(reason IN ('removed','unsupported_links')),
      retired_ms INTEGER NOT NULL CHECK(retired_ms>=0)
    ) STRICT`);
    db.exec(`CREATE INDEX IF NOT EXISTS shoko_recent_due
      ON shoko_recent_pending(retry_after_ms,seq)`);
    db.exec(`CREATE TABLE IF NOT EXISTS shoko_recent_fileid_cursor (
      id INTEGER PRIMARY KEY CHECK(id=1),
      file_id INTEGER NOT NULL CHECK(file_id>0)
    ) STRICT`);
  } catch (error) { db.close(); throw error; }
  const readCursor = db.prepare(`SELECT imported_ns AS importedNs,file_id AS fileId
    FROM shoko_recent_cursor WHERE id=1`);
  const insertCursor = db.prepare(`INSERT INTO shoko_recent_cursor
    (id,imported_ns,file_id) VALUES (1,?,?)`);
  const updateCursor = db.prepare(`UPDATE shoko_recent_cursor SET imported_ns=?,file_id=?
    WHERE id=1`);
  const readFileIdCursor = db.prepare(`SELECT file_id AS fileId
    FROM shoko_recent_fileid_cursor WHERE id=1`);
  const insertFileIdCursor = db.prepare(`INSERT INTO shoko_recent_fileid_cursor
    (id,file_id) VALUES (1,?)`);
  const updateFileIdCursor = db.prepare(`UPDATE shoko_recent_fileid_cursor
    SET file_id=? WHERE id=1`);
  const countPending = db.prepare('SELECT COUNT(*) AS total FROM shoko_recent_pending');
  const insertPending = db.prepare(`INSERT OR IGNORE INTO shoko_recent_pending(file_id)
    VALUES (?)`);
  const nextFresh = db.prepare(`SELECT file_id AS fileId FROM shoko_recent_pending
    WHERE retry_after_ms=0 ORDER BY seq LIMIT 1`);
  const nextRetry = db.prepare(`SELECT file_id AS fileId FROM shoko_recent_pending
    WHERE retry_after_ms>0 AND retry_after_ms<=? ORDER BY retry_after_ms,seq LIMIT 1`);
  const drainState = db.prepare('SELECT prefer_retry AS preferRetry FROM shoko_recent_drain_state WHERE id=1');
  const setDrainState = db.prepare('UPDATE shoko_recent_drain_state SET prefer_retry=? WHERE id=1');
  const findPending = db.prepare(`SELECT file_id AS fileId,retry_after_ms AS retryAfterMs FROM shoko_recent_pending
    WHERE file_id=?`);
  const removePending = db.prepare('DELETE FROM shoko_recent_pending WHERE file_id=?');
  const retryPending = db.prepare(`UPDATE shoko_recent_pending
    SET retry_after_ms=? WHERE file_id=?`);
  const readContinuation = db.prepare('SELECT payload FROM shoko_recent_continuation WHERE kind=?');
  const saveContinuation = db.prepare(`INSERT INTO shoko_recent_continuation(kind,payload)
    VALUES (?,?) ON CONFLICT(kind) DO UPDATE SET payload=excluded.payload`);
  const clearContinuation = db.prepare('DELETE FROM shoko_recent_continuation WHERE kind=?');
  const rollback = () => { db.exec('ROLLBACK'); };
  return {
    getContinuation(kind) {
      if (!['timestamp', 'fileid'].includes(kind)) throw new TypeError('Invalid continuation kind');
      const row = readContinuation.get(kind);
      return row ? JSON.parse(row.payload) : null;
    },
    clearContinuation(kind) {
      if (!['timestamp', 'fileid'].includes(kind)) throw new TypeError('Invalid continuation kind');
      clearContinuation.run(kind);
    },
    recordScanBatch(kind, batch) {
      const timestamp = kind === 'timestamp';
      const pendingIds = batch?.pendingFileIds ?? batch?.fileIds;
      if (!['timestamp', 'fileid'].includes(kind) ||
          !['complete', 'continuing'].includes(batch?.state) ||
          !Array.isArray(batch.fileIds) || batch.fileIds.length > 500 ||
          batch.fileIds.some((id) => !validId(id)) ||
          new Set(batch.fileIds).size !== batch.fileIds.length ||
          !Array.isArray(pendingIds) || pendingIds.some((id) => !batch.fileIds.includes(id)) ||
          (timestamp ? !validCursor(batch.newest) || !validCursor(batch.since) :
            !validId(batch.newestId) || (batch.sinceId !== null && !validId(batch.sinceId))) ||
          (batch.state === 'continuing' && (!batch.continuation ||
            JSON.stringify(batch.continuation).length > 20000))) return held('invalid_recent_batch');
      db.exec('BEGIN IMMEDIATE');
      try {
        const current = timestamp ? readCursor.get() : readFileIdCursor.get()?.fileId ?? null;
        if (timestamp ? !current || compare(current, batch.since) !== 0 || compare(batch.newest, current) < 0 :
            current !== batch.sinceId || (current !== null && batch.newestId < current)) {
          rollback(); return held('stale_recent_batch');
        }
        const priorRow = readContinuation.get(kind);
        const prior = priorRow ? JSON.parse(priorRow.payload) : null;
        const sameHead = (value) => timestamp
          ? validCursor(value?.newest) && compare(value.newest, batch.newest) === 0
          : value?.newestId === batch.newestId;
        if ((batch.state === 'complete' && (!batch.resumed || !prior || !sameHead(prior))) ||
            (batch.state === 'continuing' && (!sameHead(batch.continuation) ||
              (prior ? !sameHead(prior) : batch.fileIds.at(-1) !==
                (timestamp ? batch.newest.fileId : batch.newestId))))) {
          rollback(); return held('invalid_recent_batch');
        }
        let pending = countPending.get().total;
        let added = 0;
        for (const id of pendingIds) {
          if (insertPending.run(id).changes) { pending++; added++; }
          if (pending > maxPending) { rollback(); return held('recent_backlog_full'); }
        }
        if (batch.state === 'continuing') saveContinuation.run(kind, JSON.stringify(batch.continuation));
        else {
          if (timestamp) updateCursor.run(batch.newest.importedNs, batch.newest.fileId);
          else if (current === null) insertFileIdCursor.run(batch.newestId);
          else updateFileIdCursor.run(batch.newestId);
          clearContinuation.run(kind);
        }
        db.exec('COMMIT');
        return { state: batch.state === 'continuing' ? 'continuing' : 'recorded', added };
      } catch (error) { rollback(); throw error; }
    },
    getCapacity() { return { pending: countPending.get().total, maxPending }; },
    getBaselineState() { return recentBaselineState(readCursor.get()); },
    getCursor() {
      const saved = readCursor.get();
      return saved ? { ...saved } : null;
    },
    getFileIdCursor() { return readFileIdCursor.get()?.fileId ?? null; },
    bootstrap(cursor, initialFileIds = []) {
      if (!validCursor(cursor) || !Array.isArray(initialFileIds) ||
          initialFileIds.length > 100 || initialFileIds.some((id) => !validId(id)) ||
          new Set(initialFileIds).size !== initialFileIds.length ||
          (initialFileIds.length > 0 && initialFileIds.at(-1) !== cursor.fileId)) {
        return held('invalid_recent_baseline');
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        if (readCursor.get() || countPending.get().total !== 0) {
          rollback();
          return held('recent_baseline_exists');
        }
        if (initialFileIds.length > maxPending) {
          rollback(); return held('recent_backlog_full');
        }
        for (const fileId of initialFileIds) insertPending.run(fileId);
        insertCursor.run(cursor.importedNs, cursor.fileId);
        db.exec('COMMIT');
        return { state: 'baseline_saved' };
      } catch (error) { rollback(); throw error; }
    },
    recordBatch(batch) {
      if (batch?.state !== 'complete' || !validCursor(batch.newest) ||
          !Array.isArray(batch.fileIds) || batch.fileIds.length > 500 ||
          batch.fileIds.some((id) => !validId(id)) ||
          new Set(batch.fileIds).size !== batch.fileIds.length ||
          batch.fileIds.length > 0 && batch.fileIds.at(-1) !== batch.newest.fileId) {
        return held('invalid_recent_batch');
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        const current = readCursor.get();
        if (!current) { rollback(); return held('recent_baseline_required'); }
        const relation = compare(batch.newest, current);
        if (relation < 0 || relation === 0 && batch.fileIds.length) {
          rollback(); return held('stale_recent_batch');
        }
        if (relation > 0 && batch.fileIds.length === 0) {
          rollback(); return held('invalid_recent_batch');
        }
        let pending = countPending.get().total;
        let added = 0;
        for (const fileId of batch.fileIds) {
          const result = insertPending.run(fileId);
          if (result.changes) { pending++; added++; }
          if (pending > maxPending) {
            rollback(); return held('recent_backlog_full');
          }
        }
        if (relation > 0) updateCursor.run(batch.newest.importedNs,
          batch.newest.fileId);
        db.exec('COMMIT');
        return { state: 'recorded', added };
      } catch (error) { rollback(); throw error; }
    },
    recordFileIdBatch(batch) {
      const pendingFileIds = batch?.pendingFileIds ?? batch?.fileIds;
      if (batch?.state !== 'complete' || !validId(batch.newestId) ||
          !Array.isArray(batch.fileIds) || batch.fileIds.length > 500 ||
          batch.fileIds.some((id, index) => !validId(id) ||
            (index > 0 && id <= batch.fileIds[index - 1])) ||
          !Array.isArray(pendingFileIds) ||
          pendingFileIds.some((id, index) => !batch.fileIds.includes(id) ||
            (index > 0 && id <= pendingFileIds[index - 1])) ||
          (batch.fileIds.length > 0 &&
            batch.fileIds.at(-1) !== batch.newestId)) {
        return held('invalid_file_id_batch');
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        const current = readFileIdCursor.get()?.fileId ?? null;
        if (current !== null && (batch.newestId < current ||
            (batch.newestId === current && batch.fileIds.length > 0))) {
          rollback(); return held('stale_file_id_batch');
        }
        if (current !== null && batch.newestId > current &&
            batch.fileIds.length === 0) {
          rollback(); return held('invalid_file_id_batch');
        }
        let pending = countPending.get().total;
        let added = 0;
        for (const fileId of pendingFileIds) {
          const result = insertPending.run(fileId);
          if (result.changes) { pending++; added++; }
          if (pending > maxPending) {
            rollback(); return held('recent_backlog_full');
          }
        }
        if (current === null) insertFileIdCursor.run(batch.newestId);
        else if (batch.newestId > current) updateFileIdCursor.run(batch.newestId);
        db.exec('COMMIT');
        return { state: 'recorded', added };
      } catch (error) { rollback(); throw error; }
    },
    nextDue(nowMs) {
      if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
        throw new TypeError('Invalid recent work time');
      }
      // Give each class a bounded share. Persist the next turn with the result
      // so continuous intake and a failing retry prefix both remain fair on restart.
      const row = drainState.get().preferRetry
        ? nextRetry.get(nowMs) ?? nextFresh.get()
        : nextFresh.get() ?? nextRetry.get(nowMs);
      return row ? { ...row } : null;
    },
    retirePending({fileId,reason,nowMs}) {
      if(!validId(fileId)||!['removed','unsupported_links'].includes(reason)||!Number.isSafeInteger(nowMs)||nowMs<0) return held('invalid_recent_retirement');
      db.exec('BEGIN IMMEDIATE');
      try {
        const pending=findPending.get(fileId);
        if(!pending){rollback();return held('recent_file_not_pending');}
        setDrainState.run(pending.retryAfterMs>0?0:1);
        db.prepare('INSERT INTO shoko_recent_retirements(file_id,reason,retired_ms) VALUES (?,?,?)').run(fileId,reason,nowMs);
        removePending.run(fileId);
        db.exec('COMMIT');return {state:'retired',reason};
      }catch(error){rollback();throw error;}
    },
    recordResult({ fileId, success, nowMs } = {}) {
      if (!validId(fileId) || typeof success !== 'boolean' ||
          !Number.isSafeInteger(nowMs) || nowMs < 0 ||
          nowMs > Number.MAX_SAFE_INTEGER - 300_000) {
        return held('invalid_recent_result');
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        const pending = findPending.get(fileId);
        if (!pending) {
          rollback(); return held('recent_file_not_pending');
        }
        setDrainState.run(pending.retryAfterMs > 0 ? 0 : 1);
        if (success) removePending.run(fileId);
        else retryPending.run(nowMs + 300_000, fileId);
        db.exec('COMMIT');
        return { state: success ? 'acknowledged' : 'retry_scheduled' };
      } catch (error) { rollback(); throw error; }
    },
    close() { db.close(); },
  };
}
