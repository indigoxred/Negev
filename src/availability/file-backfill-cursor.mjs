import { DatabaseSync } from 'node:sqlite';

const validId = (value) => Number.isSafeInteger(value) && value > 0;
const validTime = (value) => Number.isSafeInteger(value) && value >= 0;
const held = (reason) => ({ state: 'held', reason });

// This cursor stores scheduling state only. It does not turn an indexed hint
// into availability or infer absence from an incomplete inventory.
export function openFileBackfillCursor(dbPath) {
  if (typeof dbPath !== 'string' || !dbPath || dbPath === ':memory:') {
    throw new TypeError('Invalid file backfill database');
  }
  const db = new DatabaseSync(dbPath, { timeout: 5_000 });
  try {
    db.exec('PRAGMA journal_mode=WAL');
    db.exec(`CREATE TABLE IF NOT EXISTS file_backfill_cursor (
      id INTEGER PRIMARY KEY CHECK(id=1),
      after_file_id INTEGER NOT NULL CHECK(after_file_id>=0),
      pass INTEGER NOT NULL CHECK(pass>0),
      receipt INTEGER NOT NULL CHECK(receipt>=0),
      pending_json TEXT,
      claimed_ms INTEGER
    ) STRICT`);
    db.exec(`INSERT OR IGNORE INTO file_backfill_cursor
      (id,after_file_id,pass,receipt) VALUES (1,0,1,0)`);
  } catch (error) { db.close(); throw error; }
  const read = db.prepare(`SELECT after_file_id AS afterFileId,pass,receipt,
    pending_json AS pendingJson,claimed_ms AS claimedMs
    FROM file_backfill_cursor WHERE id=1`);
  const saveClaim = db.prepare(`UPDATE file_backfill_cursor SET
    after_file_id=?,pass=?,receipt=?,pending_json=?,claimed_ms=? WHERE id=1`);
  const saveResult = db.prepare(`UPDATE file_backfill_cursor SET
    after_file_id=?,pending_json=NULL,claimed_ms=NULL
    WHERE id=1 AND receipt=? AND pending_json IS NOT NULL`);
  const validPage = (ids, afterFileId, limit) =>
    Array.isArray(ids) && ids.length <= limit && ids.every((id, index) =>
      validId(id) && id > (index === 0 ? afterFileId : ids[index - 1]));
  return {
    claim({ inventory, nowMs, limit = 10 } = {}) {
      if (typeof inventory?.listFileHintIds !== 'function' ||
          !validTime(nowMs) || !Number.isSafeInteger(limit) ||
          limit < 1 || limit > 10) throw new TypeError('Invalid file backfill claim');
      db.exec('BEGIN IMMEDIATE');
      try {
        const saved = read.get();
        if (saved.pendingJson !== null) {
          const fileIds = JSON.parse(saved.pendingJson);
          if (!validPage(fileIds, 0, 10) || fileIds.length === 0) {
            throw new Error('Invalid saved file backfill claim');
          }
          db.exec('COMMIT');
          return { state: 'claimed', pass: saved.pass,
            receipt: saved.receipt, claimedMs: saved.claimedMs, fileIds };
        }
        let afterFileId = saved.afterFileId;
        let pass = saved.pass;
        let ids = inventory.listFileHintIds({ afterFileId, limit });
        if (!validPage(ids, afterFileId, limit)) {
          db.exec('ROLLBACK');
          return held('invalid_file_hint_page');
        }
        if (ids.length === 0 && afterFileId > 0) {
          afterFileId = 0;
          pass++;
          ids = inventory.listFileHintIds({ afterFileId, limit });
          if (!validPage(ids, afterFileId, limit)) {
            db.exec('ROLLBACK');
            return held('invalid_file_hint_page');
          }
        }
        if (ids.length === 0) {
          if (afterFileId !== saved.afterFileId) {
            saveClaim.run(afterFileId, pass, saved.receipt, null, null);
          }
          db.exec('COMMIT');
          return { state: 'idle' };
        }
        const receipt = saved.receipt + 1;
        if (!Number.isSafeInteger(receipt)) throw new Error('Backfill receipt exhausted');
        saveClaim.run(afterFileId, pass, receipt, JSON.stringify(ids), nowMs);
        db.exec('COMMIT');
        return { state: 'claimed', pass, receipt,
          claimedMs: nowMs, fileIds: ids };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    record({ claim, outcomes, nowMs } = {}) {
      if (!validTime(nowMs) || claim?.state !== 'claimed' ||
          !validId(claim.pass) || !validId(claim.receipt) ||
          !validTime(claim.claimedMs) || nowMs < claim.claimedMs ||
          !Array.isArray(claim.fileIds) || claim.fileIds.length < 1 ||
          !validPage(claim.fileIds, 0, 10) ||
          !Array.isArray(outcomes) || outcomes.length !== claim.fileIds.length ||
          outcomes.some((item, index) => item?.fileId !== claim.fileIds[index] ||
            !['available', 'unknown', 'held'].includes(item.state))) {
        return held('invalid_file_backfill_result');
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        const saved = read.get();
        if (saved.receipt !== claim.receipt || saved.pass !== claim.pass ||
            saved.claimedMs !== claim.claimedMs ||
            saved.pendingJson !== JSON.stringify(claim.fileIds)) {
          db.exec('ROLLBACK');
          return held('stale_file_backfill_claim');
        }
        const last = claim.fileIds.at(-1);
        if (last <= saved.afterFileId ||
            saveResult.run(last, claim.receipt).changes !== 1) {
          db.exec('ROLLBACK');
          return held('stale_file_backfill_claim');
        }
        db.exec('COMMIT');
        return { state: 'recorded', count: outcomes.length };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    close() { db.close(); },
  };
}
