import { DatabaseSync } from 'node:sqlite';

const held = (reason) => ({ state: 'held', reason });
const validId = (value) => Number.isSafeInteger(value) && value > 0;
const validTime = (value) => Number.isSafeInteger(value) && value >= 0;
const validReason = (value) => typeof value === 'string' &&
  /^[a-z][a-z0-9_]{0,79}$/.test(value);
const RETRY_MS = 30 * 60_000;
const UNCERTAIN_RETRY_MS = 5 * 60_000;
// A held batch can contain many large videos. Never rehash changed evidence
// indefinitely; even transient failures receive just one automatic retry.
const RETRYABLE_HOLDS = new Set([
  'identity_unavailable', 'subtitle_unavailable', 'worker_unavailable',
  'interrupted_before_publish',
]);

// Durable, one-batch-at-a-time selection after a verified private handoff.
// An interrupted claim stays excluded until its saved publish state is
// reconciled. No timer or production service invokes this queue yet.
export function openHandoffPublishQueue(dbPath) {
  if (typeof dbPath !== 'string' || !dbPath || dbPath === ':memory:') {
    throw new TypeError('Durable handoff publish queue path required');
  }
  const db = new DatabaseSync(dbPath, { timeout: 5_000 });
  try {
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA foreign_keys=ON');
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='handoff_intents'").get()) {
      throw new TypeError('Handoff ledger must be initialized first');
    }
    db.exec(`CREATE TABLE IF NOT EXISTS handoff_publish_checks (
      attempt_id INTEGER PRIMARY KEY REFERENCES handoff_intents(attempt_id),
      version INTEGER NOT NULL CHECK(version>0),
      state TEXT CHECK(state IN ('held','publish_unknown','published_observed')),
      reason TEXT,
      checked_ms INTEGER CHECK(checked_ms>=0),
      next_due_ms INTEGER CHECK(next_due_ms>=0)
    ) STRICT`);
  } catch (error) { db.close(); throw error; }

  const next = db.prepare(`SELECT h.attempt_id AS attemptId
    FROM handoff_intents h LEFT JOIN handoff_publish_checks c
      ON c.attempt_id=h.attempt_id
    WHERE h.status IN ('prepared','publish_unknown') AND
      (c.attempt_id IS NULL OR
        (c.state IN ('held','publish_unknown') AND c.next_due_ms<=?))
    ORDER BY h.attempt_id LIMIT 1`);
  const claim = db.prepare(`INSERT INTO handoff_publish_checks
    (attempt_id,version,state,reason,checked_ms,next_due_ms)
    VALUES (?,1,NULL,NULL,NULL,NULL) ON CONFLICT(attempt_id) DO UPDATE SET
    version=version+1,state=NULL,reason=NULL,checked_ms=NULL,next_due_ms=NULL`);
  const check = db.prepare(`SELECT attempt_id AS attemptId,version,state,reason,
    checked_ms AS checkedMs,next_due_ms AS nextDueMs
    FROM handoff_publish_checks WHERE attempt_id=?`);
  const handoff = db.prepare('SELECT status FROM handoff_intents WHERE attempt_id=?');
  const save = db.prepare(`UPDATE handoff_publish_checks SET
    state=?,reason=?,checked_ms=?,next_due_ms=?
    WHERE attempt_id=? AND version=? AND state IS NULL`);
  const unresolved = db.prepare(`SELECT attempt_id AS attemptId,version
    FROM handoff_publish_checks WHERE state IS NULL
    ORDER BY attempt_id LIMIT ?`);
  const reviewNeeded = db.prepare(`SELECT attempt_id AS attemptId,reason,
    checked_ms AS checkedMs FROM handoff_publish_checks
    WHERE state='held' AND next_due_ms IS NULL AND attempt_id>?
    ORDER BY attempt_id LIMIT ?`);
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
      if (!validTime(nowMs)) throw new TypeError('Invalid publish clock');
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
          !['held', 'publish_unknown', 'published_observed'].includes(state) ||
          (state === 'held' ? !validReason(reason) : reason !== null)) {
        throw new TypeError('Invalid publish result');
      }
      const due = state === 'publish_unknown' ? checkedMs + 60_000 :
        state === 'held' && RETRYABLE_HOLDS.has(reason) && version === 1
          ? checkedMs + RETRY_MS : null;
      if (due !== null && !validTime(due)) throw new TypeError('Invalid publish clock');
      return transact(() => {
        const status = handoff.get(attemptId)?.status;
        if ((state === 'publish_unknown' && status !== 'publish_unknown') ||
            (state === 'published_observed' && status !== 'published_observed') ||
            (state === 'held' && !['prepared', 'publish_unknown'].includes(status))) {
          return held('outcome_changed');
        }
        return save.run(state, reason, checkedMs, due, attemptId, version).changes === 1
          ? { state: 'recorded' } : held('stale_claim');
      });
    },
    getResult(attemptId) {
      if (!validId(attemptId)) throw new TypeError('Invalid publish attempt');
      return check.get(attemptId) ?? null;
    },
    listReviewNeeded({ afterAttemptId = 0, limit = 20 } = {}) {
      if (!Number.isSafeInteger(afterAttemptId) || afterAttemptId < 0 ||
          !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
        throw new TypeError('Invalid publish review page');
      }
      return reviewNeeded.all(afterAttemptId, limit).map((row) => ({ ...row }));
    },
    reconcileUnresolved({ nowMs = Date.now(), limit = 20 } = {}) {
      if (!validTime(nowMs) || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
        throw new TypeError('Invalid publish reconciliation');
      }
      return transact(() => {
        const resolved = [];
        const remaining = [];
        for (const row of unresolved.all(limit)) {
          const status = handoff.get(row.attemptId)?.status;
          const state = status === 'prepared' ? 'held' :
            status === 'publish_unknown' ? 'publish_unknown' :
            status === 'published_observed' ? 'published_observed' : null;
          if (!state) { remaining.push(row.attemptId); continue; }
          const reason = state === 'held' ? 'interrupted_before_publish' : null;
          const due = state === 'held' ? nowMs + UNCERTAIN_RETRY_MS :
            state === 'publish_unknown' ? nowMs : null;
          if ((due !== null && !validTime(due)) ||
              save.run(state, reason, nowMs, due,
                row.attemptId, row.version).changes !== 1) {
            remaining.push(row.attemptId); continue;
          }
          resolved.push(row.attemptId);
        }
        return { state: 'reviewed', resolved, held: remaining };
      });
    },
    close() { db.close(); },
  };
}

export function createHandoffPublishWorker({ queue, processAttempt,
  now = Date.now } = {}) {
  if (typeof queue?.claimNext !== 'function' ||
      typeof queue?.recordResult !== 'function' ||
      typeof processAttempt !== 'function' || typeof now !== 'function') {
    throw new TypeError('Invalid handoff publish worker');
  }
  let busy = false;
  return {
    async runOnce() {
      if (busy) return held('publish_in_progress');
      busy = true;
      try {
        let receipt;
        try { receipt = queue.claimNext({ nowMs: now() }); }
        catch { return held('queue_unavailable'); }
        if (receipt.state === 'idle') return receipt;
        let result;
        try { result = await processAttempt({ attemptId: receipt.attemptId }); }
        catch { result = held('worker_unavailable'); }
        const state = ['publish_unknown', 'published_observed'].includes(result?.state)
          ? result.state : 'held';
        const reason = state === 'held' && validReason(result?.reason)
          ? result.reason : state === 'held' ? 'worker_unavailable' : null;
        try {
          const saved = queue.recordResult({ attemptId: receipt.attemptId,
            version: receipt.version, state, reason, checkedMs: now() });
          if (saved.state !== 'recorded') return held('queue_unavailable');
        } catch { return held('queue_unavailable'); }
        return { state: 'processed', attemptId: receipt.attemptId,
          result: state === 'held' ? held(reason) : { state } };
      } finally { busy = false; }
    },
  };
}
