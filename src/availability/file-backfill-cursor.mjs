import { DatabaseSync } from 'node:sqlite';

const validId = (value) => Number.isSafeInteger(value) && value > 0;
const validTime = (value) => Number.isSafeInteger(value) && value >= 0;
const held = (reason) => ({ state: 'held', reason });

// No source events are observed while the service is stopped. Withdraw old
// positives and rewind their scan cursor in one transaction so a restart can
// recheck every previously scanned file instead of waiting for a later pass.
export function resetFileBackfillEvidence(dbPath) {
  if (typeof dbPath !== 'string' || !dbPath || dbPath === ':memory:') {
    throw new TypeError('Invalid file backfill database');
  }
  const db = new DatabaseSync(dbPath, { timeout: 5_000 });
  try {
    db.exec('BEGIN IMMEDIATE');
    const tables = db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type='table' AND name IN ('file_backfill_cursor',
        'file_availability_proofs')`).get();
    if (tables.count !== 2) throw new Error('File backfill evidence unavailable');
    db.exec('DELETE FROM file_availability_proofs');
    const reset = db.prepare(`UPDATE file_backfill_cursor SET
      after_file_id=0, pass=pass+1, receipt=receipt+1,
      pending_json=NULL, claimed_ms=NULL, pair_offset=0,
      fingerprint=NULL WHERE id=1`).run();
    if (reset.changes !== 1) throw new Error('File backfill cursor unavailable');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally { db.close(); }
}

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
      claimed_ms INTEGER,
      pair_offset INTEGER NOT NULL DEFAULT 0 CHECK(pair_offset BETWEEN 0 AND 100),
      fingerprint TEXT
    ) STRICT`);
    const columns = new Set(db.prepare('PRAGMA table_info(file_backfill_cursor)')
      .all().map((column) => column.name));
    if (!columns.has('pair_offset')) db.exec(`ALTER TABLE file_backfill_cursor
      ADD COLUMN pair_offset INTEGER NOT NULL DEFAULT 0
      CHECK(pair_offset BETWEEN 0 AND 100)`);
    if (!columns.has('fingerprint')) db.exec(`ALTER TABLE file_backfill_cursor
      ADD COLUMN fingerprint TEXT`);
    db.exec(`INSERT OR IGNORE INTO file_backfill_cursor
      (id,after_file_id,pass,receipt) VALUES (1,0,1,0)`);
  } catch (error) { db.close(); throw error; }
  const read = db.prepare(`SELECT after_file_id AS afterFileId,pass,receipt,
    pending_json AS pendingJson,claimed_ms AS claimedMs,
    pair_offset AS pairOffset,fingerprint
    FROM file_backfill_cursor WHERE id=1`);
  const saveClaim = db.prepare(`UPDATE file_backfill_cursor SET
    after_file_id=?,pass=?,receipt=?,pending_json=?,claimed_ms=?,
    pair_offset=?,fingerprint=? WHERE id=1`);
  const saveResult = db.prepare(`UPDATE file_backfill_cursor SET
    after_file_id=?,pending_json=NULL,claimed_ms=NULL,
    pair_offset=0,fingerprint=NULL
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
            receipt: saved.receipt, claimedMs: saved.claimedMs, fileIds,
            pairOffset: saved.pairOffset, fingerprint: saved.fingerprint };
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
            saveClaim.run(afterFileId, pass, saved.receipt, null, null, 0, null);
          }
          db.exec('COMMIT');
          return { state: 'idle' };
        }
        const receipt = saved.receipt + 1;
        if (!Number.isSafeInteger(receipt)) throw new Error('Backfill receipt exhausted');
        saveClaim.run(afterFileId, pass, receipt, JSON.stringify(ids), nowMs,
          0, null);
        db.exec('COMMIT');
        return { state: 'claimed', pass, receipt,
          claimedMs: nowMs, fileIds: ids, pairOffset: 0, fingerprint: null };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    record({ claim, outcomes, nowMs } = {}) {
      if (!validTime(nowMs) || claim?.state !== 'claimed' ||
          !validId(claim.pass) || !validId(claim.receipt) ||
          !validTime(claim.claimedMs) || nowMs < claim.claimedMs ||
          !Number.isSafeInteger(claim.pairOffset) || claim.pairOffset < 0 ||
          claim.pairOffset > 100 ||
          (claim.fingerprint !== null &&
            !/^[0-9a-f]{64}$/.test(claim.fingerprint)) ||
          !Array.isArray(claim.fileIds) || claim.fileIds.length < 1 ||
          !validPage(claim.fileIds, 0, 10) ||
          !Array.isArray(outcomes) || outcomes.length !== claim.fileIds.length ||
          outcomes.some((item, index) => item?.fileId !== claim.fileIds[index] ||
            !['available', 'unknown', 'held', 'partial'].includes(item.state))) {
        return held('invalid_file_backfill_result');
      }
      const partial = outcomes[0]?.state === 'partial';
      if ((outcomes.some((item) => item.state === 'partial') && !partial) ||
          (partial && (outcomes.length !== 1 ||
          !Number.isSafeInteger(outcomes[0].nextPairOffset) ||
          outcomes[0].nextPairOffset < 1 ||
          (outcomes[0].fingerprint === claim.fingerprint &&
            outcomes[0].nextPairOffset <= claim.pairOffset) ||
          outcomes[0].nextPairOffset > 100 ||
          !/^[0-9a-f]{64}$/.test(outcomes[0].fingerprint)))) {
        return held('invalid_file_backfill_result');
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        const saved = read.get();
        if (saved.receipt !== claim.receipt || saved.pass !== claim.pass ||
            saved.claimedMs !== claim.claimedMs ||
            saved.pendingJson !== JSON.stringify(claim.fileIds) ||
            saved.pairOffset !== claim.pairOffset ||
            saved.fingerprint !== claim.fingerprint) {
          db.exec('ROLLBACK');
          return held('stale_file_backfill_claim');
        }
        if (partial) {
          const receipt = saved.receipt + 1;
          if (!Number.isSafeInteger(receipt)) throw new Error('Backfill receipt exhausted');
          saveClaim.run(saved.afterFileId, saved.pass, receipt,
            saved.pendingJson, nowMs, outcomes[0].nextPairOffset,
            outcomes[0].fingerprint);
          db.exec('COMMIT');
          return { state: 'partial', count: 1 };
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
