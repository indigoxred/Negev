import { DatabaseSync } from 'node:sqlite';

const held = (reason) => ({ state: 'held', reason });
const validId = (value) => Number.isSafeInteger(value) && value > 0;
const validMs = (value) => Number.isSafeInteger(value) && value >= 0;

// A preparation is deliberately separate from requests and targets. The
// acquisition queue cannot see it until the exact submitter creates a normal
// request. A lease makes crash recovery and stale-worker rejection explicit.
export function openPendingTitleLedger(dbPath) {
  if (typeof dbPath !== 'string' || !dbPath || dbPath === ':memory:') {
    throw new TypeError('A durable request database path is required');
  }
  const db = new DatabaseSync(dbPath, { timeout: 5_000 });
  try {
    db.exec('PRAGMA journal_mode=WAL');
    db.exec(`CREATE TABLE IF NOT EXISTS pending_title_intents (
      id INTEGER PRIMARY KEY,
      requester_id INTEGER NOT NULL CHECK(requester_id > 0),
      request_key TEXT NOT NULL,
      anidb_id INTEGER NOT NULL CHECK(anidb_id > 0),
      title TEXT NOT NULL,
      created_ms INTEGER NOT NULL CHECK(created_ms >= 0),
      state TEXT NOT NULL CHECK(state IN
        ('pending','resolving','resolved','complete','cancelled')),
      next_due_ms INTEGER NOT NULL CHECK(next_due_ms >= 0),
      lease_until_ms INTEGER CHECK(lease_until_ms >= 0),
      version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
      normal_request_id INTEGER CHECK(normal_request_id > 0),
      reason TEXT,
      UNIQUE(requester_id,request_key)
    ) STRICT`);
    db.exec(`CREATE INDEX IF NOT EXISTS pending_title_due
      ON pending_title_intents(state,next_due_ms,id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS pending_title_active_owner
      ON pending_title_intents(requester_id,anidb_id,state,id)`);
  } catch (error) { db.close(); throw error; }

  const byId = db.prepare('SELECT * FROM pending_title_intents WHERE id=?');
  const byKey = db.prepare(`SELECT * FROM pending_title_intents
    WHERE requester_id=? AND request_key=?`);
  const activeByTitle = db.prepare(`SELECT * FROM pending_title_intents
    WHERE requester_id=? AND anidb_id=? AND state IN ('pending','resolving')
    ORDER BY id LIMIT 1`);
  const byOwner = db.prepare(`SELECT * FROM pending_title_intents
    WHERE requester_id=? AND id<? AND state!='resolved'
    ORDER BY id DESC LIMIT ?`);
  const insert = db.prepare(`INSERT INTO pending_title_intents
    (requester_id,request_key,anidb_id,title,created_ms,state,next_due_ms)
    VALUES (?,?,?,?,?,'pending',?)`);
  const due = db.prepare(`SELECT id FROM pending_title_intents
    WHERE (state='pending' AND next_due_ms<=?) OR
      (state='resolving' AND lease_until_ms<=?)
    ORDER BY next_due_ms,id LIMIT 1`);
  const claim = db.prepare(`UPDATE pending_title_intents SET state='resolving',
    lease_until_ms=?,version=version+1 WHERE id=?`);
  const defer = db.prepare(`UPDATE pending_title_intents SET state='pending',
    next_due_ms=?,lease_until_ms=NULL,attempts=attempts+1,reason=?
    WHERE id=? AND state='resolving' AND version=?`);
  const finish = db.prepare(`UPDATE pending_title_intents SET state=?,
    lease_until_ms=NULL,normal_request_id=?,reason=?
    WHERE id=? AND state='resolving' AND version=?`);
  const cancel = db.prepare(`UPDATE pending_title_intents SET state='cancelled',
    reason='cancelled' WHERE id=? AND state='pending'`);
  const toItem = (row) => row && ({ id: row.id,
    requesterId: row.requester_id, anidbId: row.anidb_id,
    title: row.title, requestKey: row.request_key, nowMs: row.created_ms,
    state: row.state, nextDueMs: row.next_due_ms,
    leaseUntilMs: row.lease_until_ms, version: row.version,
    attempts: row.attempts, normalRequestId: row.normal_request_id,
    reason: row.reason });
  const outcome = (row, created) => ({ state: row.state, intentId: row.id,
    ...(row.normal_request_id === null ? {} :
      { normalRequestId: row.normal_request_id }), created });
  function transaction(action) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      db.exec('COMMIT');
      return result;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  return {
    enqueue({ requesterId, anidbId, title, requestKey, nowMs }) {
      if (!validId(requesterId) || !validId(anidbId) ||
          typeof title !== 'string' || title.trim() !== title ||
          !title || title.length > 300 || /[\x00-\x1f\x7f]/.test(title) ||
          typeof requestKey !== 'string' ||
          !/^[A-Za-z0-9_-]{1,64}$/.test(requestKey) || !validMs(nowMs)) {
        throw new TypeError('Invalid pending title intent');
      }
      return transaction(() => {
        const existing = byKey.get(requesterId, requestKey);
        if (existing) return existing.anidb_id === anidbId &&
          existing.title === title ? outcome(existing, false) :
          held('idempotency_key_conflict');
        const active = activeByTitle.get(requesterId, anidbId);
        if (active) return outcome(active, false);
        const id = Number(insert.run(requesterId, requestKey, anidbId,
          title, nowMs, nowMs).lastInsertRowid);
        return outcome(byId.get(id), true);
      });
    },
    get(intentId) {
      if (!validId(intentId)) throw new TypeError('Invalid intent ID');
      return toItem(byId.get(intentId)) ?? null;
    },
    getByKey({ requesterId, requestKey }) {
      if (!validId(requesterId) || typeof requestKey !== 'string' ||
          !/^[A-Za-z0-9_-]{1,64}$/.test(requestKey)) {
        throw new TypeError('Invalid pending intent key');
      }
      return toItem(byKey.get(requesterId, requestKey)) ?? null;
    },
    getActiveForTitle({ requesterId, anidbId }) {
      if (!validId(requesterId) || !validId(anidbId)) {
        throw new TypeError('Invalid pending title lookup');
      }
      return toItem(activeByTitle.get(requesterId, anidbId)) ?? null;
    },
    listForUser({ requesterId, beforeId = Number.MAX_SAFE_INTEGER,
      limit = 20 }) {
      if (!validId(requesterId) || !validId(beforeId) ||
          !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
        throw new TypeError('Invalid pending title history page');
      }
      const rows = byOwner.all(requesterId, beforeId, limit + 1);
      const items = rows.slice(0, limit).map(toItem);
      return { items, nextBeforeId: rows.length > limit
        ? items.at(-1).id : null };
    },
    claimDue({ nowMs, leaseMs }) {
      if (!validMs(nowMs) || !Number.isSafeInteger(leaseMs) ||
          leaseMs < 1_000 || leaseMs > 300_000 ||
          !Number.isSafeInteger(nowMs + leaseMs)) {
        throw new TypeError('Invalid pending intent lease');
      }
      return transaction(() => {
        const row = due.get(nowMs, nowMs);
        if (!row) return null;
        claim.run(nowMs + leaseMs, row.id);
        return toItem(byId.get(row.id));
      });
    },
    defer({ intentId, version, nowMs, delayMs, reason }) {
      if (!validId(intentId) || !validId(version) || !validMs(nowMs) ||
          !Number.isSafeInteger(delayMs) || delayMs < 1_000 ||
          delayMs > 24 * 60 * 60_000 ||
          !Number.isSafeInteger(nowMs + delayMs) ||
          typeof reason !== 'string' || !reason || reason.length > 100) {
        throw new TypeError('Invalid pending intent retry');
      }
      return transaction(() => defer.run(nowMs + delayMs, reason,
        intentId, version).changes === 1
        ? { state: 'pending', nextDueMs: nowMs + delayMs } : held('stale_claim'));
    },
    finish({ intentId, version, normalRequestId = null, reason = null, nowMs }) {
      if (!validId(intentId) || !validId(version) || !validMs(nowMs) ||
          (normalRequestId !== null && !validId(normalRequestId)) ||
          (normalRequestId === null && (typeof reason !== 'string' ||
            !reason || reason.length > 100)) ||
          (normalRequestId !== null && reason !== null)) {
        throw new TypeError('Invalid pending intent result');
      }
      const state = normalRequestId === null ? 'complete' : 'resolved';
      return transaction(() => finish.run(state, normalRequestId, reason,
        intentId, version).changes === 1
        ? { state, intentId, ...(normalRequestId === null ? { reason } :
          { normalRequestId }) } : held('stale_claim'));
    },
    cancel({ requesterId, intentId, nowMs }) {
      if (!validId(requesterId) || !validId(intentId) || !validMs(nowMs)) {
        throw new TypeError('Invalid pending intent cancellation');
      }
      return transaction(() => {
        const row = byId.get(intentId);
        if (!row || row.requester_id !== requesterId) return held('intent_not_found');
        if (row.state === 'cancelled') return { state: 'cancelled', intentId };
        if (row.state !== 'pending') return held(row.state === 'resolving'
          ? 'resolution_in_progress' : 'intent_already_finished');
        cancel.run(intentId);
        return { state: 'cancelled', intentId };
      });
    },
    close() { db.close(); },
  };
}
