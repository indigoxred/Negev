import { DatabaseSync } from 'node:sqlite';

const validId = (value) => Number.isSafeInteger(value) && value > 0;
const validTime = (value) => Number.isSafeInteger(value) && value >= 0;
const held = (reason) => ({ state: 'held', reason });
const recentWindowMs = 30 * 60_000;

// No source events are observed while the service is stopped. Withdraw old
// positives and rewind the scan. Recheck formerly proven files first, without
// treating their old proof as current or increasing the per-tick read budget.
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
    db.exec(`CREATE TABLE IF NOT EXISTS file_backfill_priority (
      file_id INTEGER PRIMARY KEY CHECK(file_id>0)
    ) STRICT`);
    db.exec(`INSERT OR IGNORE INTO file_backfill_priority (file_id)
      SELECT DISTINCT file_id FROM file_availability_proofs`);
    db.exec('DELETE FROM file_availability_proofs');
    const reset = db.prepare(`UPDATE file_backfill_cursor SET
      after_file_id=0, pass=pass+1, receipt=receipt+1,
      pending_json=NULL, claimed_ms=NULL, pair_offset=0,
      fingerprint=NULL,priority_claim=0 WHERE id=1`).run();
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
      fingerprint TEXT,
      priority_claim INTEGER NOT NULL DEFAULT 0
        CHECK(priority_claim IN (0,1))
    ) STRICT`);
    const columns = new Set(db.prepare('PRAGMA table_info(file_backfill_cursor)')
      .all().map((column) => column.name));
    if (!columns.has('pair_offset')) db.exec(`ALTER TABLE file_backfill_cursor
      ADD COLUMN pair_offset INTEGER NOT NULL DEFAULT 0
      CHECK(pair_offset BETWEEN 0 AND 100)`);
    if (!columns.has('fingerprint')) db.exec(`ALTER TABLE file_backfill_cursor
      ADD COLUMN fingerprint TEXT`);
    if (!columns.has('priority_claim')) db.exec(`ALTER TABLE file_backfill_cursor
      ADD COLUMN priority_claim INTEGER NOT NULL DEFAULT 0
      CHECK(priority_claim IN (0,1))`);
    db.exec(`CREATE TABLE IF NOT EXISTS file_backfill_priority (
      file_id INTEGER PRIMARY KEY CHECK(file_id>0),
      rank INTEGER NOT NULL DEFAULT 0 CHECK(rank IN (0,1))
    ) STRICT`);
    const priorityColumns = new Set(db.prepare('PRAGMA table_info(file_backfill_priority)')
      .all().map((column) => column.name));
    if (!priorityColumns.has('rank')) db.exec(`ALTER TABLE file_backfill_priority
      ADD COLUMN rank INTEGER NOT NULL DEFAULT 0 CHECK(rank IN (0,1))`);
    db.exec(`CREATE TABLE IF NOT EXISTS file_backfill_recent_events (
      file_id INTEGER PRIMARY KEY CHECK(file_id>0),
      expires_ms INTEGER NOT NULL CHECK(expires_ms>=0),
      confirmed INTEGER NOT NULL DEFAULT 0 CHECK(confirmed IN (0,1))
    ) STRICT`);
    db.exec(`INSERT OR IGNORE INTO file_backfill_cursor
      (id,after_file_id,pass,receipt) VALUES (1,0,1,0)`);
  } catch (error) { db.close(); throw error; }
  const read = db.prepare(`SELECT after_file_id AS afterFileId,pass,receipt,
    pending_json AS pendingJson,claimed_ms AS claimedMs,
    pair_offset AS pairOffset,fingerprint,priority_claim AS priorityClaim
    FROM file_backfill_cursor WHERE id=1`);
  const saveClaim = db.prepare(`UPDATE file_backfill_cursor SET
    after_file_id=?,pass=?,receipt=?,pending_json=?,claimed_ms=?,
    pair_offset=?,fingerprint=?,priority_claim=? WHERE id=1`);
  const saveResult = db.prepare(`UPDATE file_backfill_cursor SET
    after_file_id=?,pending_json=NULL,claimed_ms=NULL,
    pair_offset=0,fingerprint=NULL,priority_claim=0
    WHERE id=1 AND receipt=? AND pending_json IS NOT NULL`);
  const savePriorityResult = db.prepare(`UPDATE file_backfill_cursor SET
    pending_json=NULL,claimed_ms=NULL,pair_offset=0,fingerprint=NULL,
    priority_claim=0 WHERE id=1 AND receipt=? AND pending_json IS NOT NULL`);
  const nextPriority = db.prepare(`SELECT file_id AS fileId
    FROM file_backfill_priority ORDER BY rank DESC,file_id LIMIT ?`);
  const removePriority = db.prepare(`DELETE FROM file_backfill_priority
    WHERE file_id=?`);
  const hasPriority = db.prepare(`SELECT file_id FROM file_backfill_priority
    WHERE file_id=?`);
  const addPriority = db.prepare(`INSERT INTO file_backfill_priority
    (file_id,rank) VALUES (?,1) ON CONFLICT(file_id) DO UPDATE SET
    rank=1 WHERE rank=0`);
  const rememberRecent = db.prepare(`INSERT INTO file_backfill_recent_events
    (file_id,expires_ms) VALUES (?,?) ON CONFLICT(file_id) DO UPDATE SET
    expires_ms=MAX(expires_ms,excluded.expires_ms),confirmed=0`);
  const readRecent = db.prepare(`SELECT expires_ms AS expiresMs,confirmed
    FROM file_backfill_recent_events WHERE file_id=?`);
  const markConfirmed = db.prepare(`UPDATE file_backfill_recent_events
    SET confirmed=1 WHERE file_id=?`);
  const forgetRecent = db.prepare(`DELETE FROM file_backfill_recent_events
    WHERE file_id=?`);
  const pruneRecent = db.prepare(`DELETE FROM file_backfill_recent_events
    WHERE expires_ms<?`);
  const validPage = (ids, afterFileId, limit) =>
    Array.isArray(ids) && ids.length <= limit && ids.every((id, index) =>
      validId(id) && id > (index === 0 ? afterFileId : ids[index - 1]));
  const validPriorityPage = (ids, limit) =>
    Array.isArray(ids) && ids.length <= limit &&
    ids.every(validId) && new Set(ids).size === ids.length;
  return {
    prioritizeFile({ fileId, observedMs } = {}) {
      if (!validId(fileId) || !validTime(observedMs) ||
          !validTime(observedMs + recentWindowMs)) {
        throw new TypeError('Invalid recent file event');
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        pruneRecent.run(observedMs);
        rememberRecent.run(fileId, observedMs + recentWindowMs);
        const queued = addPriority.run(fileId).changes === 1;
        db.exec('COMMIT');
        return { state: queued ? 'queued' : 'unchanged' };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    confirmRecentFile({ fileId, nowMs } = {}) {
      if (!validId(fileId) || !validTime(nowMs)) {
        throw new TypeError('Invalid recent file confirmation');
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        const recent = readRecent.get(fileId);
        let queued = false;
        if (recent && nowMs <= recent.expiresMs) {
          if (hasPriority.get(fileId)) markConfirmed.run(fileId);
          else { addPriority.run(fileId); forgetRecent.run(fileId); }
          queued = true;
        } else if (recent) forgetRecent.run(fileId);
        db.exec('COMMIT');
        return { state: queued ? 'queued' : 'unchanged' };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    claim({ inventory, nowMs, limit = 10 } = {}) {
      if (typeof inventory?.listFileHintIds !== 'function' ||
          !validTime(nowMs) || !Number.isSafeInteger(limit) ||
          limit < 1 || limit > 10) throw new TypeError('Invalid file backfill claim');
      db.exec('BEGIN IMMEDIATE');
      try {
        const saved = read.get();
        if (saved.pendingJson !== null) {
          const fileIds = JSON.parse(saved.pendingJson);
          if (!(saved.priorityClaim ? validPriorityPage(fileIds, 10) :
            validPage(fileIds, 0, 10)) || fileIds.length === 0) {
            throw new Error('Invalid saved file backfill claim');
          }
          db.exec('COMMIT');
          return { state: 'claimed', pass: saved.pass,
            receipt: saved.receipt, claimedMs: saved.claimedMs, fileIds,
            pairOffset: saved.pairOffset, fingerprint: saved.fingerprint,
            ...(saved.priorityClaim ? { priority: true } : {}) };
        }
        const priorityIds = nextPriority.all(limit).map((row) => row.fileId);
        if (!validPriorityPage(priorityIds, limit)) {
          db.exec('ROLLBACK');
          return held('invalid_file_priority_page');
        }
        if (priorityIds.length > 0) {
          const receipt = saved.receipt + 1;
          if (!Number.isSafeInteger(receipt)) throw new Error('Backfill receipt exhausted');
          saveClaim.run(saved.afterFileId, saved.pass, receipt,
            JSON.stringify(priorityIds), nowMs, 0, null, 1);
          db.exec('COMMIT');
          return { state: 'claimed', pass: saved.pass, receipt,
            claimedMs: nowMs, fileIds: priorityIds, pairOffset: 0,
            fingerprint: null, priority: true };
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
            saveClaim.run(afterFileId, pass, saved.receipt, null, null, 0, null, 0);
          }
          db.exec('COMMIT');
          return { state: 'idle' };
        }
        const receipt = saved.receipt + 1;
        if (!Number.isSafeInteger(receipt)) throw new Error('Backfill receipt exhausted');
        saveClaim.run(afterFileId, pass, receipt, JSON.stringify(ids), nowMs,
          0, null, 0);
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
          (claim.priority !== undefined && claim.priority !== true) ||
          (claim.fingerprint !== null &&
            !/^[0-9a-f]{64}$/.test(claim.fingerprint)) ||
          !Array.isArray(claim.fileIds) || claim.fileIds.length < 1 ||
          !(claim.priority === true ? validPriorityPage(claim.fileIds, 10) :
            validPage(claim.fileIds, 0, 10)) ||
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
            saved.fingerprint !== claim.fingerprint ||
            saved.priorityClaim !== (claim.priority === true ? 1 : 0)) {
          db.exec('ROLLBACK');
          return held('stale_file_backfill_claim');
        }
        if (partial) {
          const receipt = saved.receipt + 1;
          if (!Number.isSafeInteger(receipt)) throw new Error('Backfill receipt exhausted');
          saveClaim.run(saved.afterFileId, saved.pass, receipt,
            saved.pendingJson, nowMs, outcomes[0].nextPairOffset,
            outcomes[0].fingerprint, saved.priorityClaim);
          db.exec('COMMIT');
          return { state: 'partial', count: 1 };
        }
        const last = claim.fileIds.at(-1);
        if (claim.priority === true) {
          for (const [index, fileId] of claim.fileIds.entries()) {
            const recent = readRecent.get(fileId);
            removePriority.run(fileId);
            if (recent && (outcomes[index].state === 'available' ||
                nowMs > recent.expiresMs)) forgetRecent.run(fileId);
            else if (recent?.confirmed) {
              addPriority.run(fileId);
              forgetRecent.run(fileId);
            }
          }
        }
        if ((claim.priority !== true && last <= saved.afterFileId) ||
            (claim.priority === true
              ? savePriorityResult.run(claim.receipt)
              : saveResult.run(last, claim.receipt)).changes !== 1) {
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
