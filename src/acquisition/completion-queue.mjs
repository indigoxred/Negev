import { DatabaseSync } from 'node:sqlite';

const held = (reason) => ({ state: 'held', reason });
const validId = (value) => Number.isSafeInteger(value) && value > 0;
const validTime = (value) => Number.isSafeInteger(value) && value >= 0;
const reasonPattern = /^[a-z][a-z0-9_]{0,79}$/;
const validTransfer = (value) => value &&
  Number.isSafeInteger(value.progressBasisPoints) &&
  value.progressBasisPoints >= 0 && value.progressBasisPoints < 10_000 &&
  (value.etaSeconds === null ||
    (Number.isSafeInteger(value.etaSeconds) && value.etaSeconds > 0 &&
      value.etaSeconds <= 7 * 24 * 60 * 60)) &&
  (value.speedBytesPerSecond === null ||
    (Number.isSafeInteger(value.speedBytesPerSecond) &&
      value.speedBytesPerSecond >= 0 &&
      value.speedBytesPerSecond <= 10 * 1024 ** 3)) &&
  ['active', 'stalled', 'queued', 'paused'].includes(value.transferState);
const RETRY_MS = 30 * 60_000;
const SESSION_RETRY_MS = 60_000;
const INCOMPLETE_RETRY_MS = 5 * 60_000;
const INCONCLUSIVE_RETRY_MS = [RETRY_MS, 2 * 60 * 60_000,
  8 * 60 * 60_000, 24 * 60 * 60_000];

// One durable cursor for the expensive completed-file path. Open only after
// the acquisition and handoff ledgers have created their tables. A crash with
// an unfinished claim is intentionally not auto-retried: a private copy may
// exist even when the handoff journal write was interrupted.
export function openCompletionQueue(dbPath, { pureMode = false } = {}) {
  if (typeof dbPath !== 'string' || !dbPath || dbPath === ':memory:') {
    throw new TypeError('Durable completion queue path required');
  }
  const db = new DatabaseSync(dbPath, { timeout: 5_000 });
  if (typeof pureMode !== 'boolean') throw new TypeError('Invalid handoff mode');
  const handoffTable = pureMode ? 'pure_move_intents' : 'handoff_intents';
  const cursorTable = pureMode ? 'pure_move_completion_cursor' : 'completion_cursor';
  const checksTable = pureMode ? 'pure_move_completion_checks' : 'completion_checks';
  try {
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA foreign_keys=ON');
    for (const table of ['requests', 'acquisition_attempts', 'acquisition_starts',
      'acquisition_rejections', 'acquisition_retirements', 'acquisition_releases',
      'acquisition_stall_retirement_intents', handoffTable]) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
        throw new TypeError('Completion ledgers must be initialized first');
      }
    }
    db.exec(`CREATE TABLE IF NOT EXISTS ${cursorTable} (
      id INTEGER PRIMARY KEY CHECK(id=1),
      after_id INTEGER NOT NULL CHECK(after_id>=0),
      pass INTEGER NOT NULL CHECK(pass>0)
    ) STRICT`);
    db.exec(`CREATE TABLE IF NOT EXISTS ${checksTable} (
      attempt_id INTEGER PRIMARY KEY REFERENCES acquisition_attempts(id),
      pass INTEGER NOT NULL CHECK(pass>0),
      state TEXT CHECK(state IN ('held','handoff_prepared','rejected_held')),
      reason TEXT,
      checked_ms INTEGER CHECK(checked_ms>=0),
      next_due_ms INTEGER CHECK(next_due_ms>=0),
      inconclusive_count INTEGER NOT NULL DEFAULT 0 CHECK(inconclusive_count>=0),
      progress_bp INTEGER CHECK(progress_bp>=0 AND progress_bp<10000),
      eta_sec INTEGER CHECK(eta_sec>0 AND eta_sec<=604800),
      speed_bps INTEGER CHECK(speed_bps>=0 AND speed_bps<=10737418240),
      transfer_state TEXT CHECK(transfer_state IN
        ('active','stalled','queued','paused'))
    ) STRICT`);
    if (!db.prepare(`PRAGMA table_info(${checksTable})`).all()
      .some((column) => column.name === 'inconclusive_count')) {
      db.exec(`ALTER TABLE ${checksTable} ADD COLUMN inconclusive_count
        INTEGER NOT NULL DEFAULT 0 CHECK(inconclusive_count>=0)`);
    }
    for (const [name, definition] of [
      ['progress_bp', 'INTEGER CHECK(progress_bp>=0 AND progress_bp<10000)'],
      ['eta_sec', 'INTEGER CHECK(eta_sec>0 AND eta_sec<=604800)'],
      ['speed_bps', 'INTEGER CHECK(speed_bps>=0 AND speed_bps<=10737418240)'],
      ['transfer_state', "TEXT CHECK(transfer_state IN ('active','stalled','queued','paused'))"],
    ]) {
      if (!db.prepare(`PRAGMA table_info(${checksTable})`).all()
        .some((column) => column.name === name)) {
        db.exec(`ALTER TABLE ${checksTable} ADD COLUMN ${name} ${definition}`);
      }
    }
    db.exec(`INSERT INTO ${cursorTable} VALUES (1,0,1) ON CONFLICT(id) DO NOTHING`);
  } catch (error) { db.close(); throw error; }

  const cursor = db.prepare(`SELECT after_id AS afterId,pass FROM ${cursorTable} WHERE id=1`);
  // In pure-move mode, a torrent already proved outside the dedicated staging
  // mount cannot become eligible through another timed retry. Preserve its
  // recorded hold for review and let newer in-staging attempts advance.
  const outsideStagingFilter = pureMode
    ? "AND (c.attempt_id IS NULL OR c.reason!='incomplete_path_outside_staging')"
    : '';
  const next = db.prepare(`SELECT a.id FROM acquisition_attempts a
    JOIN requests r ON r.id=a.request_id AND r.status='held' AND r.cancelled_ms IS NULL
    JOIN acquisition_starts s ON s.attempt_id=a.id AND s.torrent_hash=a.torrent_hash
    LEFT JOIN acquisition_releases x ON x.attempt_id=a.id
    LEFT JOIN acquisition_rejections j ON j.attempt_id=a.id
    LEFT JOIN acquisition_retirements t ON t.attempt_id=a.id
    LEFT JOIN acquisition_stall_retirement_intents si ON si.attempt_id=a.id
    LEFT JOIN acquisition_request_suspensions hold ON hold.request_id=r.id
    LEFT JOIN ${handoffTable} h ON h.attempt_id=a.id
    LEFT JOIN ${checksTable} c ON c.attempt_id=a.id
    WHERE a.id>? AND a.status='torrent_observed' AND
      hold.request_id IS NULL AND x.attempt_id IS NULL AND
      j.attempt_id IS NULL AND t.attempt_id IS NULL AND si.attempt_id IS NULL AND
      h.attempt_id IS NULL AND
      (c.attempt_id IS NULL OR (c.state='held' AND c.next_due_ms<=?))
      ${outsideStagingFilter}
    -- The durable cursor is an attempt ID, so traversal must follow ID order.
    -- Priority before ID can skip an older due retry on every pass.
    ORDER BY a.id LIMIT 1`);
  const advance = db.prepare(`UPDATE ${cursorTable} SET after_id=? WHERE id=1 AND after_id=? AND pass=?`);
  const wrap = db.prepare(`UPDATE ${cursorTable} SET after_id=0,pass=pass+1 WHERE id=1 AND after_id=? AND pass=?`);
  const claim = db.prepare(`INSERT INTO ${checksTable}(attempt_id,pass,state,reason,checked_ms,next_due_ms)
    VALUES (?,?,NULL,NULL,NULL,NULL) ON CONFLICT(attempt_id) DO UPDATE SET
    pass=excluded.pass,state=NULL,reason=NULL,checked_ms=NULL,next_due_ms=NULL,
    progress_bp=NULL,eta_sec=NULL,speed_bps=NULL,transfer_state=NULL`);
  const check = db.prepare(`SELECT attempt_id AS attemptId,pass,state,reason,
    checked_ms AS checkedMs,next_due_ms AS nextDueMs
    FROM ${checksTable} WHERE attempt_id=?`);
  const save = db.prepare(`UPDATE ${checksTable} SET
      state=?,reason=?,checked_ms=?,next_due_ms=?,inconclusive_count=?,
      progress_bp=?,eta_sec=?,speed_bps=?,transfer_state=?
    WHERE attempt_id=? AND pass=? AND state IS NULL`);
  const lookupCount = db.prepare(`SELECT inconclusive_count AS count
    FROM ${checksTable} WHERE attempt_id=? AND pass=? AND state IS NULL`);
  const prepared = db.prepare(`SELECT 1 FROM ${handoffTable} WHERE attempt_id=?`);
  const rejected = db.prepare('SELECT 1 FROM acquisition_rejections WHERE attempt_id=?');
  const retryInterrupted = db.prepare(`UPDATE ${checksTable} SET
    state='held',reason='interrupted_retry',checked_ms=?,next_due_ms=?,
    progress_bp=NULL,eta_sec=NULL,speed_bps=NULL,transfer_state=NULL
    WHERE attempt_id=? AND pass=? AND state IS NULL
      AND NOT EXISTS (SELECT 1 FROM ${handoffTable} WHERE attempt_id=?)
      AND NOT EXISTS (SELECT 1 FROM acquisition_rejections WHERE attempt_id=?)`);
  const unresolved = db.prepare(`SELECT attempt_id AS attemptId,pass FROM ${checksTable}
    WHERE attempt_id>? AND state IS NULL ORDER BY attempt_id LIMIT ?`);
  const reviewNeeded = db.prepare(`SELECT c.attempt_id AS attemptId
    FROM ${checksTable} c
    JOIN acquisition_attempts a ON a.id=c.attempt_id AND a.status='torrent_observed'
    JOIN requests r ON r.id=a.request_id AND r.status='held' AND r.cancelled_ms IS NULL
    LEFT JOIN ${handoffTable} h ON h.attempt_id=a.id
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
    recordResult({ attemptId, pass, state, reason = null, checkedMs,
      transfer = null }) {
      if (!validId(attemptId) || !validId(pass) ||
          !['held', 'handoff_prepared', 'rejected_held'].includes(state) ||
          (state === 'held' ? typeof reason !== 'string' || !reasonPattern.test(reason) :
            reason !== null) || !validTime(checkedMs) ||
          (transfer !== null && (state !== 'held' || reason !== 'incomplete' ||
            !validTransfer(transfer)))) {
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
          ['file_lookup_inconclusive',
            'file_offline_lookup_inconclusive'].includes(reason)
          ? Math.min(prior.count + 1, INCONCLUSIVE_RETRY_MS.length) : 0;
        const delay = ['provider_http_403', 'authentication_backoff',
          'authentication_unavailable', 'torrent_not_stopped']
          .includes(reason) ? SESSION_RETRY_MS :
          reason === 'incomplete' ? INCOMPLETE_RETRY_MS :
          inconclusiveCount > 0 ? INCONCLUSIVE_RETRY_MS[inconclusiveCount - 1] : RETRY_MS;
        if (!validTime(checkedMs + delay)) throw new TypeError('Invalid completion clock');
        const outsideStagingHold = pureMode && state === 'held' &&
          reason === 'incomplete_path_outside_staging';
        return save.run(state, reason, checkedMs,
          state === 'held' && !outsideStagingHold ? checkedMs + delay : null,
          inconclusiveCount, transfer?.progressBasisPoints ?? null,
          transfer?.etaSeconds ?? null,
          transfer?.speedBytesPerSecond ?? null,
          transfer?.transferState ?? null,
          attemptId, pass).changes === 1
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
          if (!state) {
            // The completion stage only writes to private holding until a
            // handoff intent is durable. Recheck the original torrent after
            // an interrupted private copy; never infer a published import.
            const retried = transact(() => retryInterrupted.run(nowMs, nowMs,
              row.attemptId, row.pass, row.attemptId, row.attemptId).changes === 1);
            if (retried) resolved.push(row.attemptId);
            else heldAttempts.push(row.attemptId);
            continue;
          }
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
            checkedMs: now(),
            transfer: savedState === 'held' && reason === 'incomplete'
              ? result?.transfer ?? null : null });
          if (saved.state !== 'recorded') return held('queue_unavailable');
        } catch { return held('queue_unavailable'); }
        return { state: 'processed', attemptId: claim.attemptId,
          result: savedState === 'held' ? held(reason ?? 'worker_unavailable') :
            { state: savedState } };
      } finally { busy = false; }
    },
  };
}
