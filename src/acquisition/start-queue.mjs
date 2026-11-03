import { DatabaseSync } from 'node:sqlite';

const held = (reason) => ({ state: 'held', reason });
const validId = (value) => Number.isSafeInteger(value) && value > 0;
const validTime = (value) => Number.isSafeInteger(value) && value >= 0;
const validReason = (value) => typeof value === 'string' &&
  /^[a-z][a-z0-9_]{0,79}$/.test(value);
const RETRY_MS = 30 * 60_000;
const INTERRUPTED_RETRY_MS = 5 * 60_000;

// One stopped torrent per explicit tick. Only a guarded start coordinator may
// be supplied as processAttempt. A saved start intent excludes that attempt
// forever; qBittorrent activity and completion need separate observations.
export function openStartQueue(dbPath) {
  if (typeof dbPath !== 'string' || !dbPath || dbPath === ':memory:') {
    throw new TypeError('Durable start queue path required');
  }
  const db = new DatabaseSync(dbPath, { timeout: 5_000 });
  try {
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA foreign_keys=ON');
    for (const table of ['requests', 'acquisition_attempts', 'acquisition_starts',
      'acquisition_releases', 'acquisition_rejections', 'acquisition_retirements']) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
        throw new TypeError('Acquisition ledgers must be initialized first');
      }
    }
    db.exec(`CREATE TABLE IF NOT EXISTS start_checks (
      attempt_id INTEGER PRIMARY KEY REFERENCES acquisition_attempts(id),
      version INTEGER NOT NULL CHECK(version>0),
      state TEXT CHECK(state IN ('held','start_unknown')),
      reason TEXT,
      checked_ms INTEGER CHECK(checked_ms>=0),
      next_due_ms INTEGER CHECK(next_due_ms>=0)
    ) STRICT`);
  } catch (error) { db.close(); throw error; }

  const next = db.prepare(`SELECT a.id AS attemptId FROM acquisition_attempts a
    JOIN requests r ON r.id=a.request_id AND r.status='held'
    LEFT JOIN acquisition_starts s ON s.attempt_id=a.id
    LEFT JOIN acquisition_releases x ON x.attempt_id=a.id
    LEFT JOIN acquisition_rejections j ON j.attempt_id=a.id
    LEFT JOIN acquisition_retirements t ON t.attempt_id=a.id
    LEFT JOIN start_checks c ON c.attempt_id=a.id
    WHERE a.status IN ('dispatch_unknown','torrent_observed') AND
      s.attempt_id IS NULL AND
      x.attempt_id IS NULL AND j.attempt_id IS NULL AND t.attempt_id IS NULL AND
      (c.attempt_id IS NULL OR (c.state='held' AND c.next_due_ms<=?))
    ORDER BY a.id LIMIT 1`);
  const claim = db.prepare(`INSERT INTO start_checks
    (attempt_id,version,state,reason,checked_ms,next_due_ms)
    VALUES (?,1,NULL,NULL,NULL,NULL) ON CONFLICT(attempt_id) DO UPDATE SET
    version=version+1,state=NULL,reason=NULL,checked_ms=NULL,next_due_ms=NULL`);
  const check = db.prepare(`SELECT attempt_id AS attemptId,version,state,reason,
    checked_ms AS checkedMs,next_due_ms AS nextDueMs
    FROM start_checks WHERE attempt_id=?`);
  const start = db.prepare('SELECT status FROM acquisition_starts WHERE attempt_id=?');
  const save = db.prepare(`UPDATE start_checks SET state=?,reason=?,checked_ms=?,next_due_ms=?
    WHERE attempt_id=? AND version=? AND state IS NULL`);
  const unresolved = db.prepare(`SELECT attempt_id AS attemptId,version FROM start_checks
    WHERE attempt_id>? AND state IS NULL ORDER BY attempt_id LIMIT ?`);
  const reviewNeeded = db.prepare(`SELECT c.attempt_id AS attemptId,
    c.reason,c.checked_ms AS checkedMs FROM start_checks c
    JOIN acquisition_attempts a ON a.id=c.attempt_id
    JOIN requests r ON r.id=a.request_id AND r.status='held'
    LEFT JOIN acquisition_starts s ON s.attempt_id=a.id
    LEFT JOIN acquisition_releases x ON x.attempt_id=a.id
    LEFT JOIN acquisition_rejections j ON j.attempt_id=a.id
    LEFT JOIN acquisition_retirements t ON t.attempt_id=a.id
    WHERE c.attempt_id>? AND c.state='held' AND c.next_due_ms IS NULL
      AND s.attempt_id IS NULL AND x.attempt_id IS NULL AND
      j.attempt_id IS NULL AND t.attempt_id IS NULL
    ORDER BY c.attempt_id LIMIT ?`);
  const transact = (action) => {
    let begun = false;
    try {
      db.exec('BEGIN IMMEDIATE'); begun = true;
      const result = action();
      db.exec('COMMIT'); begun = false;
      return result;
    } catch (error) {
      if (begun) db.exec('ROLLBACK');
      throw error;
    }
  };
  return {
    claimNext({ nowMs = Date.now() } = {}) {
      if (!validTime(nowMs)) throw new TypeError('Invalid start clock');
      return transact(() => {
        const row = next.get(nowMs);
        if (!row) return { state: 'idle' };
        claim.run(row.attemptId);
        return { state: 'claimed', attemptId: row.attemptId,
          version: check.get(row.attemptId).version };
      });
    },
    recordResult({ attemptId, version, state, reason = null, checkedMs }) {
      if (!validId(attemptId) || !validId(version) || !validTime(checkedMs) ||
          !['held', 'start_unknown'].includes(state) ||
          (state === 'held' ? !validReason(reason) : reason !== null)) {
        throw new TypeError('Invalid start result');
      }
      const due = state === 'held' && version === 1 ? checkedMs + RETRY_MS : null;
      if (due !== null && !validTime(due)) throw new TypeError('Invalid start clock');
      return transact(() => {
        const intent = start.get(attemptId);
        if ((state === 'start_unknown') !== Boolean(intent)) return held('outcome_changed');
        return save.run(state, reason, checkedMs, due, attemptId, version).changes === 1
          ? { state: 'recorded' } : held('stale_claim');
      });
    },
    getResult(attemptId) {
      if (!validId(attemptId)) throw new TypeError('Invalid start attempt');
      return check.get(attemptId) ?? null;
    },
    listReviewNeeded({ afterAttemptId = 0, limit = 20 } = {}) {
      if (!Number.isSafeInteger(afterAttemptId) || afterAttemptId < 0 ||
          !Number.isSafeInteger(limit) || limit < 1 || limit > 21) {
        throw new TypeError('Invalid start review page');
      }
      return reviewNeeded.all(afterAttemptId, limit).map((row) => ({ ...row }));
    },
    reconcileUnresolved({ nowMs = Date.now(), limit = 20 } = {}) {
      if (!validTime(nowMs) || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
        throw new TypeError('Invalid start reconciliation');
      }
      return transact(() => {
        const resolved = [];
        const remaining = [];
        let afterId = 0;
        while (true) {
          const rows = unresolved.all(afterId, limit);
          if (rows.length === 0) break;
          for (const row of rows) {
            const state = start.get(row.attemptId) ? 'start_unknown' : 'held';
            const reason = state === 'held' ? 'interrupted_before_intent' : null;
            const due = state === 'held' ? nowMs + INTERRUPTED_RETRY_MS : null;
            if (due !== null && !validTime(due)) {
              remaining.push(row.attemptId); continue;
            }
            if (save.run(state, reason, nowMs, due,
              row.attemptId, row.version).changes === 1) resolved.push(row.attemptId);
            else remaining.push(row.attemptId);
          }
          afterId = rows.at(-1).attemptId;
          if (rows.length < limit) break;
        }
        return { state: 'reviewed', resolved, held: remaining };
      });
    },
    close() { db.close(); },
  };
}

export function createStartWorker({ queue, processAttempt, now = Date.now } = {}) {
  if (typeof queue?.claimNext !== 'function' ||
      typeof queue?.recordResult !== 'function' ||
      typeof processAttempt !== 'function' || typeof now !== 'function') {
    throw new TypeError('Invalid start worker');
  }
  let busy = false;
  return {
    async runOnce() {
      if (busy) return held('start_in_progress');
      busy = true;
      try {
        let claim;
        try { claim = queue.claimNext({ nowMs: now() }); }
        catch { return held('queue_unavailable'); }
        if (claim.state === 'idle') return claim;
        let result;
        try { result = await processAttempt({ attemptId: claim.attemptId }); }
        catch { result = held('worker_unavailable'); }
        const state = result?.state === 'start_unknown' ? 'start_unknown' : 'held';
        const reason = state === 'held' && validReason(result?.reason)
          ? result.reason : state === 'held' ? 'worker_unavailable' : null;
        try {
          const saved = queue.recordResult({ attemptId: claim.attemptId,
            version: claim.version, state, reason, checkedMs: now() });
          if (saved.state !== 'recorded') return held('queue_unavailable');
        } catch { return held('queue_unavailable'); }
        return { state: 'processed', attemptId: claim.attemptId,
          result: state === 'held' ? held(reason) : { state } };
      } finally { busy = false; }
    },
  };
}
