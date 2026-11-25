// Scheduling state only. Exact source/card/physical proof remains the worker's job.
export function createFileArrivalRetries(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='file_backfill_arrivals'").get();
    db.exec(`CREATE TABLE IF NOT EXISTS file_backfill_arrivals (
      file_id INTEGER PRIMARY KEY CHECK(file_id>0),
      observed_ms INTEGER NOT NULL CHECK(observed_ms>=0),
      due_ms INTEGER NOT NULL CHECK(due_ms>=0),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
      version INTEGER NOT NULL DEFAULT 1 CHECK(version>0)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS file_backfill_arrival_due ON file_backfill_arrivals(due_ms,file_id);
    CREATE TABLE IF NOT EXISTS file_backfill_arrival_claims (
      receipt INTEGER NOT NULL,file_id INTEGER NOT NULL,version INTEGER NOT NULL,
      PRIMARY KEY(receipt,file_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS file_backfill_lane_state (
      id INTEGER PRIMARY KEY CHECK(id=1),phase INTEGER NOT NULL CHECK(phase BETWEEN 0 AND 2)
    ) STRICT;
    INSERT OR IGNORE INTO file_backfill_lane_state VALUES(1,0)`);
    // Recover retained legacy arrival markers without rebasing their age.
    if (!exists) db.exec(`INSERT OR IGNORE INTO file_backfill_arrivals(file_id,observed_ms,due_ms)
      SELECT file_id,MAX(0,expires_ms-1800000),MAX(0,expires_ms-1800000)
      FROM file_backfill_recent_events;
      INSERT OR IGNORE INTO file_backfill_arrivals(file_id,observed_ms,due_ms)
      SELECT p.file_id,c.claimed_ms,c.claimed_ms FROM file_backfill_priority p,
        file_backfill_cursor c,json_each(c.pending_json) f
      WHERE c.priority_claim=1 AND c.claimed_ms IS NOT NULL AND p.rank=1 AND f.value=p.file_id;
      INSERT OR IGNORE INTO file_backfill_arrival_claims(receipt,file_id,version)
      SELECT c.receipt,a.file_id,a.version FROM file_backfill_cursor c,
        json_each(c.pending_json) f JOIN file_backfill_arrivals a ON a.file_id=f.value
      WHERE c.priority_claim=1 AND c.claimed_ms IS NOT NULL AND a.observed_ms<=c.claimed_ms`);
    db.exec('COMMIT');
  } catch(error) { db.exec('ROLLBACK'); throw error; }
  const get = db.prepare('SELECT * FROM file_backfill_arrivals WHERE file_id=?');
  const prioritize = db.prepare(`INSERT INTO file_backfill_arrivals(file_id,observed_ms,due_ms) VALUES(?,?,?)
    ON CONFLICT(file_id) DO UPDATE SET observed_ms=excluded.observed_ms,due_ms=excluded.due_ms,
      attempts=0,version=version+1 WHERE excluded.observed_ms>file_backfill_arrivals.observed_ms`);
  const due = db.prepare(`SELECT a.file_id AS fileId FROM file_backfill_arrivals a
    WHERE a.due_ms<=? AND NOT EXISTS(SELECT 1 FROM file_backfill_priority p WHERE p.file_id=a.file_id)
    ORDER BY a.due_ms,a.file_id LIMIT ?`);
  const phase = db.prepare('SELECT phase FROM file_backfill_lane_state WHERE id=1');
  const advance = db.prepare('UPDATE file_backfill_lane_state SET phase=? WHERE id=1');
  const capture = db.prepare(`INSERT INTO file_backfill_arrival_claims(receipt,file_id,version)
    SELECT ?,file_id,version FROM file_backfill_arrivals WHERE file_id=?`);
  const claim = db.prepare('SELECT version FROM file_backfill_arrival_claims WHERE receipt=? AND file_id=?');
  const remove = db.prepare('DELETE FROM file_backfill_arrivals WHERE file_id=? AND version=?');
  const retry = db.prepare('UPDATE file_backfill_arrivals SET due_ms=?,attempts=attempts+1 WHERE file_id=? AND version=?');
  return {
    prioritize(fileId,observedMs) { return prioritize.run(fileId,observedMs,observedMs).changes===1; },
    due(nowMs,limit) { return due.all(nowMs,limit).map(row=>row.fileId); },
    phase() { return phase.get().phase; },
    advance(selected) { advance.run((selected+1)%3); },
    capture(receipt,ids,nowMs) {
      db.exec('DELETE FROM file_backfill_arrival_claims');
      for(const id of ids) {
        // Card-invalidated priority work also needs a retry after an early miss.
        // Its first scheduling time is separate from source/proof timestamps.
        db.prepare(`INSERT OR IGNORE INTO file_backfill_arrivals(file_id,observed_ms,due_ms)
          SELECT file_id,?,? FROM file_backfill_priority WHERE file_id=? AND rank=1`).run(nowMs,nowMs,id);
        capture.run(receipt,id);
      }
    },
    transfer(oldReceipt,newReceipt) { db.prepare('UPDATE file_backfill_arrival_claims SET receipt=? WHERE receipt=?').run(newReceipt,oldReceipt); },
    current(receipt,fileId) { const row=get.get(fileId);return !row || row.version===claim.get(receipt,fileId)?.version; },
    settle(receipt,outcome,nowMs) {
      const row=get.get(outcome.fileId);
      if(!row || row.version!==claim.get(receipt,outcome.fileId)?.version)return false;
      if(outcome.state==='available'||outcome.terminal===true)remove.run(row.file_id,row.version);
      else {
        const age=nowMs-row.observed_ms;
        const delay=age<900000?60000:300000;
        retry.run(nowMs+delay,row.file_id,row.version);
      }
      return true;
    },
    release(receipt) { db.prepare('DELETE FROM file_backfill_arrival_claims WHERE receipt=?').run(receipt); },
  };
}
