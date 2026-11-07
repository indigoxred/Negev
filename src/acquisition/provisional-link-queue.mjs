import { DatabaseSync } from 'node:sqlite';

const held = (reason) => ({ state: 'held', reason });
const validId = (value) => Number.isSafeInteger(value) && value > 0;
const validTime = (value) => Number.isSafeInteger(value) && value >= 0;
const validReason = (value) => typeof value === 'string' &&
  /^[a-z][a-z0-9_]{0,79}$/.test(value);
const RETRY_MS = new Map([
  ['shoko_import_pending', 10 * 60_000],
  ['shoko_native_match_pending', 10 * 60_000],
  ['shoko_fallback_pending', 10 * 60_000],
  ['shoko_link_evidence_unavailable', 10 * 60_000],
  ['shoko_preview_unavailable', 10 * 60_000],
  ['shoko_file_changed', 10 * 60_000],
  ['shoko_unavailable', 10 * 60_000],
  ['shoko_link_unverified', 10 * 60_000],
  ['shoko_link_save_failed', 10 * 60_000],
  ['worker_unavailable', 10 * 60_000],
  ['interrupted_link_attempt', 5 * 60_000],
]);

// This source-only queue is separate from download/publication. A Shoko wait
// advances the cursor to another published handoff; every link is re-observed
// after an interrupted claim. Construction creates no timer or network call.
export function openProvisionalLinkQueue(dbPath) {
  if (typeof dbPath !== 'string' || !dbPath || dbPath === ':memory:') {
    throw new TypeError('Durable link queue path required');
  }
  const db = new DatabaseSync(dbPath, { timeout: 5_000 });
  try {
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA foreign_keys=ON');
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='handoff_intents'").get()) {
      throw new TypeError('Handoff ledger must be initialized first');
    }
    db.exec(`CREATE TABLE IF NOT EXISTS provisional_link_checks (
      attempt_id INTEGER PRIMARY KEY REFERENCES handoff_intents(attempt_id),
      version INTEGER NOT NULL CHECK(version>0),
      state TEXT CHECK(state IN ('held','shoko_files_identified')),
      reason TEXT,
      checked_ms INTEGER CHECK(checked_ms>=0),
      next_due_ms INTEGER CHECK(next_due_ms>=0)
    ) STRICT`);
  } catch (error) { db.close(); throw error; }
  const next = db.prepare(`SELECT h.attempt_id AS attemptId
    FROM handoff_intents h LEFT JOIN provisional_link_checks c
      ON c.attempt_id=h.attempt_id
    WHERE h.status='published_observed' AND
      CASE WHEN json_valid(h.manifest_json)
        THEN json_extract(h.manifest_json,'$.identity') ELSE NULL END
        ='provisional' AND
      (c.attempt_id IS NULL OR (c.state='held' AND c.next_due_ms<=?))
    -- Never-checked handoffs go first; among retries, serve the oldest
    -- completed check. A short retry delay must not starve later imports.
    ORDER BY (c.checked_ms IS NOT NULL), c.checked_ms, h.attempt_id LIMIT 1`);
  const claim = db.prepare(`INSERT INTO provisional_link_checks
    (attempt_id,version,state,reason,checked_ms,next_due_ms)
    VALUES (?,1,NULL,NULL,NULL,NULL) ON CONFLICT(attempt_id) DO UPDATE SET
      version=version+1,state=NULL,reason=NULL,checked_ms=NULL,next_due_ms=NULL`);
  const check = db.prepare(`SELECT attempt_id AS attemptId,version,state,reason,
    checked_ms AS checkedMs,next_due_ms AS nextDueMs
    FROM provisional_link_checks WHERE attempt_id=?`);
  const handoff = db.prepare('SELECT status FROM handoff_intents WHERE attempt_id=?');
  const save = db.prepare(`UPDATE provisional_link_checks SET
    state=?,reason=?,checked_ms=?,next_due_ms=?
    WHERE attempt_id=? AND version=? AND state IS NULL`);
  const unresolved = db.prepare(`SELECT attempt_id AS attemptId,version
    FROM provisional_link_checks WHERE state IS NULL AND attempt_id>?
    ORDER BY attempt_id LIMIT ?`);
  const review = db.prepare(`SELECT attempt_id AS attemptId,reason,
    checked_ms AS checkedMs FROM provisional_link_checks
    WHERE state='held' AND next_due_ms IS NULL ORDER BY attempt_id LIMIT ?`);
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
      if (!validTime(nowMs)) throw new TypeError('Invalid link clock');
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
          !['held', 'shoko_files_identified'].includes(state) ||
          (state === 'held' ? !validReason(reason) : reason !== null)) {
        throw new TypeError('Invalid link result');
      }
      const retry = state === 'held' ? RETRY_MS.get(reason) : undefined;
      const due = retry === undefined ? null : checkedMs + retry;
      if (due !== null && !validTime(due)) throw new TypeError('Invalid link clock');
      return transact(() => handoff.get(attemptId)?.status === 'published_observed' &&
        save.run(state, reason, checkedMs, due, attemptId, version).changes === 1
        ? { state: 'recorded' } : held('outcome_changed'));
    },
    getResult(attemptId) {
      if (!validId(attemptId)) throw new TypeError('Invalid link attempt');
      return check.get(attemptId) ?? null;
    },
    listReviewNeeded({ limit = 20 } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
        throw new TypeError('Invalid link review page');
      }
      return review.all(limit);
    },
    reconcileUnresolved({ nowMs = Date.now(), limit = 20 } = {}) {
      if (!validTime(nowMs) || !validTime(nowMs + 5 * 60_000) ||
          !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
        throw new TypeError('Invalid link clock');
      }
      return transact(() => {
        const resolved = [], remaining = [];
        let afterId = 0;
        while (true) {
          const rows = unresolved.all(afterId, limit);
          if (rows.length === 0) break;
          for (const row of rows) {
            if (handoff.get(row.attemptId)?.status !== 'published_observed' ||
                save.run('held', 'interrupted_link_attempt', nowMs,
                  nowMs + 5 * 60_000, row.attemptId, row.version).changes !== 1) {
              remaining.push(row.attemptId);
            } else resolved.push(row.attemptId);
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

export function createProvisionalLinkWorker({ queue, processAttempt,
  now = Date.now } = {}) {
  if (typeof queue?.claimNext !== 'function' ||
      typeof queue?.recordResult !== 'function' ||
      typeof processAttempt !== 'function' || typeof now !== 'function') {
    throw new TypeError('Invalid provisional link worker');
  }
  let busy = false;
  return {
    async runOnce() {
      if (busy) return held('link_in_progress');
      busy = true;
      try {
        let receipt;
        try { receipt = queue.claimNext({ nowMs: now() }); }
        catch { return held('queue_unavailable'); }
        if (receipt.state === 'idle') return receipt;
        let result;
        try { result = await processAttempt({ attemptId: receipt.attemptId }); }
        catch { result = held('worker_unavailable'); }
        const state = result?.state === 'shoko_files_identified'
          ? 'shoko_files_identified' : 'held';
        const reason = state === 'held' && validReason(result?.reason)
          ? result.reason : state === 'held' ? 'worker_unavailable' : null;
        try {
          if (queue.recordResult({ attemptId: receipt.attemptId,
            version: receipt.version, state, reason,
            checkedMs: now() }).state !== 'recorded') {
            return held('queue_unavailable');
          }
        } catch { return held('queue_unavailable'); }
        return { state: 'processed', attemptId: receipt.attemptId,
          result: state === 'held' ? held(reason) : { state } };
      } finally { busy = false; }
    },
  };
}
