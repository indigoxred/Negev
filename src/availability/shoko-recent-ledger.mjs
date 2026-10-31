import { DatabaseSync } from 'node:sqlite';

const held = (reason) => ({ state: 'held', reason });
const validId = (value) => Number.isSafeInteger(value) && value > 0;
const validCursor = (value) => validId(value?.fileId) &&
  typeof value.importedNs === 'string' && /^[0-9]{1,22}$/.test(value.importedNs) &&
  BigInt(value.importedNs) > 0n;
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
    db.exec(`CREATE INDEX IF NOT EXISTS shoko_recent_due
      ON shoko_recent_pending(retry_after_ms,seq)`);
  } catch (error) { db.close(); throw error; }
  const readCursor = db.prepare(`SELECT imported_ns AS importedNs,file_id AS fileId
    FROM shoko_recent_cursor WHERE id=1`);
  const insertCursor = db.prepare(`INSERT INTO shoko_recent_cursor
    (id,imported_ns,file_id) VALUES (1,?,?)`);
  const updateCursor = db.prepare(`UPDATE shoko_recent_cursor SET imported_ns=?,file_id=?
    WHERE id=1`);
  const countPending = db.prepare('SELECT COUNT(*) AS total FROM shoko_recent_pending');
  const insertPending = db.prepare(`INSERT OR IGNORE INTO shoko_recent_pending(file_id)
    VALUES (?)`);
  const nextPending = db.prepare(`SELECT file_id AS fileId FROM shoko_recent_pending
    WHERE retry_after_ms<=? ORDER BY seq LIMIT 1`);
  const findPending = db.prepare(`SELECT file_id AS fileId FROM shoko_recent_pending
    WHERE file_id=?`);
  const removePending = db.prepare('DELETE FROM shoko_recent_pending WHERE file_id=?');
  const retryPending = db.prepare(`UPDATE shoko_recent_pending
    SET retry_after_ms=? WHERE file_id=?`);
  const rollback = () => { db.exec('ROLLBACK'); };
  return {
    getCursor() {
      const saved = readCursor.get();
      return saved ? { ...saved } : null;
    },
    bootstrap(cursor) {
      if (!validCursor(cursor)) return held('invalid_recent_baseline');
      db.exec('BEGIN IMMEDIATE');
      try {
        if (readCursor.get() || countPending.get().total !== 0) {
          rollback();
          return held('recent_baseline_exists');
        }
        insertCursor.run(cursor.importedNs, cursor.fileId);
        db.exec('COMMIT');
        return { state: 'baseline_saved' };
      } catch (error) { rollback(); throw error; }
    },
    recordBatch(batch) {
      if (batch?.state !== 'complete' || !validCursor(batch.newest) ||
          !Array.isArray(batch.fileIds) || batch.fileIds.length > 500 ||
          batch.fileIds.some((id) => !validId(id)) ||
          new Set(batch.fileIds).size !== batch.fileIds.length) {
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
    nextDue(nowMs) {
      if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
        throw new TypeError('Invalid recent work time');
      }
      const row = nextPending.get(nowMs);
      return row ? { ...row } : null;
    },
    recordResult({ fileId, success, nowMs } = {}) {
      if (!validId(fileId) || typeof success !== 'boolean' ||
          !Number.isSafeInteger(nowMs) || nowMs < 0 ||
          nowMs > Number.MAX_SAFE_INTEGER - 300_000) {
        return held('invalid_recent_result');
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        if (!findPending.get(fileId)) {
          rollback(); return held('recent_file_not_pending');
        }
        if (success) removePending.run(fileId);
        else retryPending.run(nowMs + 300_000, fileId);
        db.exec('COMMIT');
        return { state: success ? 'acknowledged' : 'retry_scheduled' };
      } catch (error) { rollback(); throw error; }
    },
    close() { db.close(); },
  };
}
