import { DatabaseSync } from 'node:sqlite';

const validId = (value) => Number.isSafeInteger(value) && value > 0;
const validTime = (value) => Number.isSafeInteger(value) && value >= 0;
const held = (reason) => ({ state: 'held', reason });
const RETRY_DELAY_MS = 30 * 60_000;

// This queue only chooses which saved request to examine. It never searches
// an indexer, calls qBittorrent, or treats a held item as completed.
export function openAcquisitionRequestQueue(dbPath) {
  if (typeof dbPath !== 'string' || !dbPath || dbPath === ':memory:') {
    throw new TypeError('Durable acquisition queue path required');
  }
  const db = new DatabaseSync(dbPath, { timeout: 5_000 });
  try {
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA foreign_keys=ON');
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='requests'").get()) {
      throw new TypeError('Request ledger must be initialized first');
    }
    db.exec(`CREATE TABLE IF NOT EXISTS acquisition_request_cursor (
      id INTEGER PRIMARY KEY CHECK(id=1),
      after_id INTEGER NOT NULL CHECK(after_id>=0),
      pass INTEGER NOT NULL CHECK(pass>0)
    ) STRICT`);
    db.exec(`CREATE TABLE IF NOT EXISTS acquisition_request_checks (
      request_id INTEGER PRIMARY KEY REFERENCES requests(id),
      pass INTEGER NOT NULL CHECK(pass>0),
      state TEXT CHECK(state IN ('held','stopped_observed')),
      reason TEXT,
      attempt_id INTEGER CHECK(attempt_id>0),
      checked_ms INTEGER CHECK(checked_ms>=0),
      next_due_ms INTEGER CHECK(next_due_ms>=0),
      candidate_offset INTEGER NOT NULL DEFAULT 0 CHECK(candidate_offset BETWEEN 0 AND 50)
    ) STRICT`);
    if (!db.prepare('PRAGMA table_info(acquisition_request_checks)').all()
      .some((column) => column.name === 'candidate_offset')) {
      db.exec(`ALTER TABLE acquisition_request_checks ADD COLUMN candidate_offset
        INTEGER NOT NULL DEFAULT 0 CHECK(candidate_offset BETWEEN 0 AND 50)`);
    }
    db.exec('INSERT INTO acquisition_request_cursor VALUES (1,0,1) ON CONFLICT(id) DO NOTHING');
  } catch (error) { db.close(); throw error; }
  const cursor = db.prepare('SELECT after_id AS afterId,pass FROM acquisition_request_cursor WHERE id=1');
  // An unfinished claim remains excluded after a crash. Later request IDs
  // and later passes continue; reconciliation must close the uncertain claim.
  const next = db.prepare(`SELECT r.id,COALESCE(c.candidate_offset,0) AS candidateOffset FROM requests r
    LEFT JOIN acquisition_request_checks c ON c.request_id=r.id
    WHERE r.id>? AND r.status='held' AND
      (c.request_id IS NULL OR (c.state IS NOT NULL AND c.next_due_ms<=?))
    ORDER BY r.id LIMIT 1`);
  const advance = db.prepare('UPDATE acquisition_request_cursor SET after_id=? WHERE id=1 AND after_id=? AND pass=?');
  const wrap = db.prepare('UPDATE acquisition_request_cursor SET after_id=0,pass=pass+1 WHERE id=1 AND after_id=? AND pass=?');
  const claim = db.prepare(`INSERT INTO acquisition_request_checks(request_id,pass,state,reason,attempt_id,checked_ms,next_due_ms)
    VALUES (?,?,NULL,NULL,NULL,NULL,NULL) ON CONFLICT(request_id) DO UPDATE SET
    pass=excluded.pass,state=NULL,reason=NULL,attempt_id=NULL,checked_ms=NULL,next_due_ms=NULL`);
  const save = db.prepare(`UPDATE acquisition_request_checks SET
    state=?,reason=?,attempt_id=?,checked_ms=?,next_due_ms=?,
    candidate_offset=COALESCE(?,candidate_offset)
    WHERE request_id=? AND pass=? AND state IS NULL`);
  const result = db.prepare(`SELECT request_id AS requestId,pass,state,reason,
    attempt_id AS attemptId,candidate_offset AS candidateOffset,
    checked_ms AS checkedMs,next_due_ms AS nextDueMs
    FROM acquisition_request_checks WHERE request_id=?`);
  const unresolved = db.prepare(`SELECT request_id AS requestId,pass
    FROM acquisition_request_checks WHERE request_id>? AND state IS NULL
    ORDER BY request_id LIMIT ?`);
  const transact = (action) => {
    let begun = false;
    try {
      db.exec('BEGIN IMMEDIATE'); begun = true;
      const value = action();
      db.exec('COMMIT'); begun = false;
      return value;
    } catch (error) {
      if (begun) db.exec('ROLLBACK');
      throw error;
    }
  };
  return {
    claimNext({ nowMs = Date.now() } = {}) {
      if (!validTime(nowMs)) throw new TypeError('Invalid acquisition queue clock');
      return transact(() => {
        const position = cursor.get();
        const row = next.get(position.afterId, nowMs);
        if (!row) {
          if (wrap.run(position.afterId, position.pass).changes !== 1) {
            throw new Error('Acquisition cursor changed');
          }
          return { state: 'pass_complete', pass: position.pass };
        }
        if (advance.run(row.id, position.afterId, position.pass).changes !== 1) {
          throw new Error('Acquisition cursor changed');
        }
        claim.run(row.id, position.pass);
        return { state: 'claimed', requestId: row.id, pass: position.pass,
          ...(row.candidateOffset > 0 ? { candidateOffset: row.candidateOffset } : {}) };
      });
    },
    recordResult({ requestId, pass, state, reason = null, attemptId = null,
      nextCandidateOffset = null, checkedMs }) {
      if (!validId(requestId) || !validId(pass) ||
          !['held', 'stopped_observed'].includes(state) ||
          (state === 'held' ? typeof reason !== 'string' ||
            !/^[a-z][a-z0-9_]{0,79}$/.test(reason) || attemptId !== null :
            reason !== null || !validId(attemptId)) ||
          (nextCandidateOffset !== null &&
            (!Number.isSafeInteger(nextCandidateOffset) ||
              nextCandidateOffset < 0 || nextCandidateOffset > 50)) ||
          !validTime(checkedMs) || !validTime(checkedMs + RETRY_DELAY_MS)) {
        throw new TypeError('Invalid acquisition check result');
      }
      return save.run(state, reason, attemptId, checkedMs, checkedMs + RETRY_DELAY_MS,
        nextCandidateOffset,
        requestId, pass).changes === 1
        ? { state: 'recorded' } : held('stale_claim');
    },
    getResult(requestId) {
      if (!validId(requestId)) throw new TypeError('Invalid request ID');
      const row = result.get(requestId);
      if (!row) return null;
      const { candidateOffset, ...other } = row;
      return candidateOffset > 0 ? { ...other, candidateOffset } : other;
    },
    listUnresolved({ afterId = 0, limit = 20 } = {}) {
      if (!Number.isSafeInteger(afterId) || afterId < 0 ||
          !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
        throw new TypeError('Invalid unresolved claim page');
      }
      return unresolved.all(afterId, limit).map((row) => ({ ...row }));
    },
    close() { db.close(); },
  };
}

// One bounded page. Each request is claimed before processing, so a failure
// in one title cannot stop later titles or issue two claims in the same pass.
export function createAcquisitionPageWorker({ queue, processRequest,
  limit = 3, now = Date.now } = {}) {
  if (typeof queue?.claimNext !== 'function' ||
      typeof queue?.recordResult !== 'function' ||
      typeof processRequest !== 'function' || typeof now !== 'function' ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 10) {
    throw new TypeError('Invalid acquisition page worker');
  }
  let busy = false;
  return {
    async runOnce() {
      if (busy) return held('page_in_progress');
      busy = true;
      const results = [];
      try {
        for (let i = 0; i < limit; i++) {
          let next;
          try { next = queue.claimNext({ nowMs: now() }); }
          catch { return { state: 'held', reason: 'queue_unavailable', results }; }
          if (next.state === 'pass_complete') {
            return { state: 'pass_complete', pass: next.pass, results };
          }
          let outcome;
          try { outcome = await processRequest({ requestId: next.requestId,
            candidateOffset: next.candidateOffset ?? 0 }); }
          catch { outcome = held('worker_unavailable'); }
          if ((outcome?.nextCandidateOffset !== undefined &&
              (!Number.isSafeInteger(outcome.nextCandidateOffset) ||
                outcome.nextCandidateOffset < 0 || outcome.nextCandidateOffset > 50)) ||
              (outcome?.state === 'stopped_observed' && !validId(outcome.attemptId)) ||
              (outcome?.state !== 'stopped_observed' &&
              (outcome?.state !== 'held' ||
                typeof outcome.reason !== 'string' ||
                !/^[a-z][a-z0-9_]{0,79}$/.test(outcome.reason)))) {
            outcome = held('worker_unavailable');
          }
          const state = outcome.state;
          const reason = state === 'held' ? outcome.reason : null;
          try {
            const saved = queue.recordResult({ requestId: next.requestId,
              pass: next.pass, state, reason,
              attemptId: state === 'stopped_observed' ? outcome.attemptId : null,
              nextCandidateOffset: outcome.nextCandidateOffset ?? null,
              checkedMs: now() });
            if (saved.state !== 'recorded') return { state: 'held',
              reason: 'queue_unavailable', results };
          } catch { return { state: 'held', reason: 'queue_unavailable', results }; }
          results.push({ requestId: next.requestId, state,
            ...(state === 'stopped_observed' ? { attemptId: outcome.attemptId } : {}),
            ...(reason === null ? {} : { reason }) });
        }
        return { state: 'page', results };
      } finally { busy = false; }
    },
  };
}

// Invoke before starting request workers after a restart. The acquisition
// ledger must prove that a claim has no saved attempt before it can retry.
// An uncertain provider read or any saved attempt leaves the claim held.
export async function reconcileUnresolvedAcquisitionClaims({ queue,
  inspectRequest, now = Date.now, limit = 20 } = {}) {
  if (typeof queue?.listUnresolved !== 'function' ||
      typeof queue?.recordResult !== 'function' ||
      typeof inspectRequest !== 'function' || typeof now !== 'function' ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new TypeError('Invalid acquisition claim recovery');
  }
  const claims = queue.listUnresolved({ limit });
  const resolved = [];
  const heldClaims = [];
  for (const claim of claims) {
    let observation;
    try { observation = await inspectRequest(claim.requestId); }
    catch { observation = null; }
    if (observation?.state !== 'no_attempt') {
      heldClaims.push(claim.requestId);
      continue;
    }
    try {
      const saved = queue.recordResult({ requestId: claim.requestId,
        pass: claim.pass, state: 'held', reason: 'reconciled_no_dispatch',
        checkedMs: now() });
      if (saved.state === 'recorded') resolved.push(claim.requestId);
      else heldClaims.push(claim.requestId);
    } catch { heldClaims.push(claim.requestId); }
  }
  return { state: 'reviewed', resolved, held: heldClaims };
}
