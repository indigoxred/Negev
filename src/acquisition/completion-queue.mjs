import { DatabaseSync } from 'node:sqlite';

const held = (reason) => ({ state: 'held', reason });
const validId = (value) => Number.isSafeInteger(value) && value > 0;
const validTime = (value) => Number.isSafeInteger(value) && value >= 0;
const reasonPattern = /^[a-z][a-z0-9_]{0,79}$/;
const RETRY_MS = 30 * 60_000;
const INCOMPLETE_RETRY_MS = 5 * 60_000;
const INCONCLUSIVE_RETRY_MS = [RETRY_MS, 2 * 60 * 60_000,
  8 * 60 * 60_000, 24 * 60 * 60_000];

// One durable cursor for the expensive completed-file path. Open only after
// the acquisition and handoff ledgers have created their tables. A crash with
// an unfinished claim is intentionally not auto-retried: a private copy may
// exist even when the handoff journal write was interrupted.
export function openCompletionQueue(dbPath) {
  if (typeof dbPath !== 'string' || !dbPath || dbPath === ':memory:') {
    throw new TypeError('Durable completion queue path required');
  }
  const db = new DatabaseSync(dbPath, { timeout: 5_000 });
  try {
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA foreign_keys=ON');
    for (const table of ['requests', 'acquisition_attempts', 'acquisition_starts',
      'acquisition_rejections', 'acquisition_retirements', 'acquisition_releases',
      'acquisition_stall_retirement_intents', 'handoff_intents']) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
        throw new TypeError('Completion ledgers must be initialized first');
      }
    }
    db.exec(`CREATE TABLE IF NOT EXISTS completion_cursor (
      id INTEGER PRIMARY KEY CHECK(id=1),
      after_id INTEGER NOT NULL CHECK(after_id>=0),
      pass INTEGER NOT NULL CHECK(pass>0)
    ) STRICT`);
    db.exec(`CREATE TABLE IF NOT EXISTS completion_checks (
      attempt_id INTEGER PRIMARY KEY REFERENCES acquisition_attempts(id),
      pass INTEGER NOT NULL CHECK(pass>0),
      state TEXT CHECK(state IN ('held','handoff_prepared','rejected_held')),
      reason TEXT,
      checked_ms INTEGER CHECK(checked_ms>=0),
      next_due_ms INTEGER CHECK(next_due_ms>=0),
      inconclusive_count INTEGER NOT NULL DEFAULT 0 CHECK(inconclusive_count>=0)
    ) STRICT`);
    if (!db.prepare('PRAGMA table_info(completion_checks)').all()
      .some((column) => column.name === 'inconclusive_count')) {
      db.exec(`ALTER TABLE completion_checks ADD COLUMN inconclusive_count
        INTEGER NOT NULL DEFAULT 0 CHECK(inconclusive_count>=0)`);
    }
    db.exec('INSERT INTO completion_cursor VALUES (1,0,1) ON CONFLICT(id) DO NOTHING');
  } catch (error) { db.close(); throw error; }

  const cursor = db.prepare('SELECT after_id AS afterId,pass FROM completion_cursor WHERE id=1');
  const next = db.prepare(`SELECT a.id FROM acquisition_attempts a
    JOIN requests r ON r.id=a.request_id AND r.status='held'
    JOIN acquisition_starts s ON s.attempt_id=a.id AND s.torrent_hash=a.torrent_hash
    LEFT JOIN acquisition_releases x ON x.attempt_id=a.id
    LEFT JOIN acquisition_rejections j ON j.attempt_id=a.id
    LEFT JOIN acquisition_retirements t ON t.attempt_id=a.id
    LEFT JOIN acquisition_stall_retirement_intents si ON si.attempt_id=a.id
    LEFT JOIN handoff_intents h ON h.attempt_id=a.id
    LEFT JOIN completion_checks c ON c.attempt_id=a.id
    WHERE a.id>? AND a.status='torrent_observed' AND x.attempt_id IS NULL AND
      j.attempt_id IS NULL AND t.attempt_id IS NULL AND si.attempt_id IS NULL AND
      h.attempt_id IS NULL AND
      (c.attempt_id IS NULL OR (c.state='held' AND c.next_due_ms<=?))
    -- The durable cursor is an attempt ID, so traversal must follow ID order.
    -- Priority before ID can skip an older due retry on every pass.
    ORDER BY a.id LIMIT 1`);
  const advance = db.prepare('UPDATE completion_cursor SET after_id=? WHERE id=1 AND after_id=? AND pass=?');
  const wrap = db.prepare('UPDATE completion_cursor SET after_id=0,pass=pass+1 WHERE id=1 AND after_id=? AND pass=?');
  const claim = db.prepare(`INSERT INTO completion_checks(attempt_id,pass,state,reason,checked_ms,next_due_ms)
    VALUES (?,?,NULL,NULL,NULL,NULL) ON CONFLICT(attempt_id) DO UPDATE SET
    pass=excluded.pass,state=NULL,reason=NULL,checked_ms=NULL,next_due_ms=NULL`);
  const check = db.prepare(`SELECT attempt_id AS attemptId,pass,state,reason,
    checked_ms AS checkedMs,next_due_ms AS nextDueMs
    FROM completion_checks WHERE attempt_id=?`);
  const save = db.prepare(`UPDATE completion_checks SET
      state=?,reason=?,checked_ms=?,next_due_ms=?,inconclusive_count=?
    WHERE attempt_id=? AND pass=? AND state IS NULL`);
  const lookupCount = db.prepare(`SELECT inconclusive_count AS count
    FROM completion_checks WHERE attempt_id=? AND pass=? AND state IS NULL`);
  const prepared = db.prepare('SELECT 1 FROM handoff_intents WHERE attempt_id=?');
  const rejected = db.prepare('SELECT 1 FROM acquisition_rejections WHERE attempt_id=?');
  const unresolved = db.prepare(`SELECT attempt_id AS attemptId,pass FROM completion_checks
    WHERE attempt_id>? AND state IS NULL ORDER BY attempt_id LIMIT ?`);
  const reviewNeeded = db.prepare(`SELECT c.attempt_id AS attemptId
    FROM completion_checks c
    JOIN acquisition_attempts a ON a.id=c.attempt_id AND a.status='torrent_observed'
    JOIN requests r ON r.id=a.request_id AND r.status='held'
    LEFT JOIN handoff_intents h ON h.attempt_id=a.id
    LEFT JOIN acquisition_rejections j ON j.attempt_id=a.id
    LEFT JOIN acquisition_releases x ON x.attempt_id=a.id
    LEFT JOIN acquisition_retirements t ON t.attempt_id=a.id
    LEFT JOIN acquisition_stall_retirement_intents si ON si.attempt_id=a.id
    WHERE c.attempt_id>? AND c.state IS NULL AND h.attempt_id IS NULL
      AND j.attempt_id IS NULL AND x.attempt_id IS NULL AND t.attempt_id IS NULL
      AND si.attempt_id IS NULL
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
      if (!validTime(nowMs)) throw new TypeError('Invalid completion queue clock');
      return transact(() => {
        const position = cursor.get();
        const row = next.get(position.afterId, nowMs);
        if (!row) {
          if (wrap.run(position.afterId, position.pass).changes !== 1) {
            throw new Error('Completion cursor changed');
          }
          return { state: 'pass_complete', pass: position.pass };
        }
        if (advance.run(row.id, position.afterId, position.pass).changes !== 1) {
          throw new Error('Completion cursor changed');
        }
        claim.run(row.id, position.pass);
        return { state: 'claimed', attemptId: row.id, pass: position.pass };
      });
    },
    recordResult({ attemptId, pass, state, reason = null, checkedMs }) {
      if (!validId(attemptId) || !validId(pass) ||
          !['held', 'handoff_prepared', 'rejected_held'].includes(state) ||
          (state === 'held' ? typeof reason !== 'string' || !reasonPattern.test(reason) :
            reason !== null) || !validTime(checkedMs)) {
        throw new TypeError('Invalid completion result');
      }
      return transact(() => {
        if (state === 'handoff_prepared' && !prepared.get(attemptId)) {
          return held('handoff_not_recorded');
        }
        if (state === 'rejected_held' && !rejected.get(attemptId)) {
          return held('rejection_not_recorded');
        }
        if (state === 'held' && (prepared.get(attemptId) || rejected.get(attemptId))) {
          return held('outcome_changed');
        }
        const prior = lookupCount.get(attemptId, pass);
        if (!prior) return held('stale_claim');
        const inconclusiveCount = state === 'held' &&
          reason === 'file_lookup_inconclusive'
          ? Math.min(prior.count + 1, INCONCLUSIVE_RETRY_MS.length) : 0;
        const delay = reason === 'incomplete' ? INCOMPLETE_RETRY_MS :
          inconclusiveCount > 0 ? INCONCLUSIVE_RETRY_MS[inconclusiveCount - 1] : RETRY_MS;
        if (!validTime(checkedMs + delay)) throw new TypeError('Invalid completion clock');
        return save.run(state, reason, checkedMs,
          state === 'held' ? checkedMs + delay : null,
          inconclusiveCount, attemptId, pass).changes === 1
          ? { state: 'recorded' } : held('stale_claim');
      });
    },
    getResult(attemptId) {
      if (!validId(attemptId)) throw new TypeError('Invalid attempt ID');
      return check.get(attemptId) ?? null;
    },
    listReviewNeeded({ afterAttemptId = 0, limit = 20,
      nowMs = Date.now() } = {}) {
      if (!Number.isSafeInteger(afterAttemptId) || afterAttemptId < 0 ||
          !Number.isSafeInteger(limit) || limit < 1 || limit > 21 ||
          !validTime(nowMs)) throw new TypeError('Invalid completion review page');
      // This is the time the unresolved state was observed, not a fabricated
      // interruption timestamp. Old claims did not save their claim time.
      return reviewNeeded.all(afterAttemptId, limit).map(({ attemptId }) => ({
        attemptId, reason: 'completion_interrupted', observedMs: nowMs }));
    },
    listUnresolved({ afterId = 0, limit = 20 } = {}) {
      if (!Number.isSafeInteger(afterId) || afterId < 0 ||
          !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
        throw new TypeError('Invalid unresolved completion page');
      }
      return unresolved.all(afterId, limit);
    },
    reconcileUnresolved({ afterId = 0, limit = 20, nowMs = Date.now() } = {}) {
      if (!validTime(nowMs)) throw new TypeError('Invalid completion clock');
      const resolved = [];
      const heldAttempts = [];
      while (true) {
        const rows = this.listUnresolved({ afterId, limit });
        if (rows.length === 0) break;
        for (const row of rows) {
          const state = prepared.get(row.attemptId) ? 'handoff_prepared' :
            rejected.get(row.attemptId) ? 'rejected_held' : null;
          if (!state) { heldAttempts.push(row.attemptId); continue; }
          const saved = this.recordResult({ attemptId: row.attemptId,
            pass: row.pass, state, checkedMs: nowMs });
          if (saved.state === 'recorded') resolved.push(row.attemptId);
          else heldAttempts.push(row.attemptId);
        }
        afterId = rows.at(-1).attemptId;
        if (rows.length < limit) break;
      }
      return { state: 'reviewed', resolved, held: heldAttempts };
    },
    close() { db.close(); },
  };
}

// One attempt per explicit tick limits disk hashing/copying. There is no
// timer here and an interrupted operation requires restart reconciliation.
export function createCompletionWorker({ queue, processAttempt, now = Date.now } = {}) {
  if (typeof queue?.claimNext !== 'function' ||
      typeof queue?.recordResult !== 'function' ||
      typeof processAttempt !== 'function' || typeof now !== 'function') {
    throw new TypeError('Invalid completion worker');
  }
  let busy = false;
  return {
    async runOnce() {
      if (busy) return held('completion_in_progress');
      busy = true;
      try {
        let claim;
        try { claim = queue.claimNext({ nowMs: now() }); }
        catch { return held('queue_unavailable'); }
        if (claim.state === 'pass_complete') return claim;
        let result;
        try { result = await processAttempt({ attemptId: claim.attemptId }); }
        catch { result = held('worker_unavailable'); }
        const state = result?.state;
        const reason = state === 'held' && typeof result.reason === 'string' &&
          reasonPattern.test(result.reason) ? result.reason : null;
        const savedState = state === 'handoff_prepared' || state === 'rejected_held'
          ? state : 'held';
        try {
          const saved = queue.recordResult({ attemptId: claim.attemptId,
            pass: claim.pass, state: savedState,
            reason: savedState === 'held' ? reason ?? 'worker_unavailable' : null,
            checkedMs: now() });
          if (saved.state !== 'recorded') return held('queue_unavailable');
        } catch { return held('queue_unavailable'); }
        return { state: 'processed', attemptId: claim.attemptId,
          result: savedState === 'held' ? held(reason ?? 'worker_unavailable') :
            { state: savedState } };
      } finally { busy = false; }
    },
  };
}
