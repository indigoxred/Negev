import { DatabaseSync } from 'node:sqlite';

const validId = (value) => Number.isSafeInteger(value) && value > 0;
const validTime = (value) => Number.isSafeInteger(value) && value >= 0;
const positiveLifetimeMs = 30 * 60_000;
const retryMs = 5 * 60_000;
const leaseMs = 10 * 60_000;

// Shoko changes invalidate cached public proof. Inventory alone never creates
// an Available status; only the exact public Plex observer can do that.
export function openDirectAvailabilityQueue(dbPath) {
  if (typeof dbPath !== 'string' || !dbPath || dbPath === ':memory:') {
    throw new TypeError('Durable direct availability database required');
  }
  const db = new DatabaseSync(dbPath, { timeout: 5_000 });
  try {
    db.exec('PRAGMA journal_mode=WAL');
    db.exec(`CREATE TABLE IF NOT EXISTS direct_availability_targets (
      anidb_id INTEGER NOT NULL CHECK(anidb_id>0),
      episode_id INTEGER NOT NULL CHECK(episode_id>0),
      observed_ms INTEGER NOT NULL CHECK(observed_ms>=0),
      due_ms INTEGER NOT NULL CHECK(due_ms>=0),
      version INTEGER NOT NULL CHECK(version>0),
      priority INTEGER NOT NULL DEFAULT 0 CHECK(priority IN (0,1)),
      state TEXT NOT NULL CHECK(state IN ('pending','checking','available','unknown')),
      verified_ms INTEGER,
      PRIMARY KEY(anidb_id,episode_id)
    ) STRICT`);
    if (!db.prepare(`PRAGMA table_info(direct_availability_targets)`).all()
      .some((column) => column.name === 'priority')) {
      db.exec(`ALTER TABLE direct_availability_targets ADD COLUMN
        priority INTEGER NOT NULL DEFAULT 0 CHECK(priority IN (0,1))`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS direct_availability_priority_due
      ON direct_availability_targets(priority DESC,due_ms,anidb_id,episode_id)`);
  } catch (error) { db.close(); throw error; }
  const find = db.prepare(`SELECT observed_ms AS observedMs,due_ms AS dueMs,
    version,state,verified_ms AS verifiedMs FROM direct_availability_targets
    WHERE anidb_id=? AND episode_id=?`);
  const insert = db.prepare(`INSERT INTO direct_availability_targets
    (anidb_id,episode_id,observed_ms,due_ms,version,priority,state,verified_ms)
    VALUES (?,?,?, ?,1,?,'pending',NULL)`);
  const replace = db.prepare(`UPDATE direct_availability_targets SET
    observed_ms=?,due_ms=?,version=version+1,priority=?,
    state='pending',verified_ms=NULL
    WHERE anidb_id=? AND episode_id=? AND observed_ms<=?`);
  const due = db.prepare(`SELECT anidb_id AS anidbId,episode_id AS episodeId,
    observed_ms AS observedMs,version FROM direct_availability_targets
    WHERE due_ms<=? ORDER BY priority DESC,due_ms,anidb_id,episode_id LIMIT 1`);
  const claim = db.prepare(`UPDATE direct_availability_targets SET
    state='checking',due_ms=?,version=version+1,priority=0,verified_ms=NULL
    WHERE anidb_id=? AND episode_id=? AND version=?`);
  const record = db.prepare(`UPDATE direct_availability_targets SET
    state=?,due_ms=?,verified_ms=? WHERE anidb_id=? AND episode_id=?
    AND observed_ms=? AND version=? AND state='checking'`);
  const positiveForAnime = db.prepare(`SELECT episode_id AS episodeId
    FROM direct_availability_targets WHERE anidb_id=? AND state='available'
    AND verified_ms>? AND verified_ms<=? ORDER BY episode_id LIMIT 10001`);
  return {
    getObservation({ anidbId, episodeId }) {
      if (!validId(anidbId) || !validId(episodeId)) {
        throw new TypeError('Invalid availability target');
      }
      const row = find.get(anidbId, episodeId);
      return row ? { observedMs: row.observedMs } : null;
    },
    enqueue({ anidbId, episodeId, observedMs, priority = 'reconcile' }) {
      if (!validId(anidbId) || !validId(episodeId) || !validTime(observedMs) ||
          !['reconcile', 'event'].includes(priority)) {
        throw new TypeError('Invalid Shoko availability observation');
      }
      const rank = priority === 'event' ? 1 : 0;
      const old = find.get(anidbId, episodeId);
      const changed = !old || observedMs > old.observedMs ||
        (rank === 1 && observedMs === old.observedMs);
      if (!old) insert.run(anidbId, episodeId, observedMs, observedMs, rank);
      else if (changed) {
        replace.run(observedMs, observedMs, rank,
          anidbId, episodeId, observedMs);
      }
      return { state: changed ? 'queued' : 'unchanged' };
    },
    getStatus({ anidbId, episodeId, nowMs }) {
      if (!validId(anidbId) || !validId(episodeId) || !validTime(nowMs)) {
        throw new TypeError('Invalid availability status query');
      }
      const row = find.get(anidbId, episodeId);
      return row?.state === 'available' && validTime(row.verifiedMs) &&
        row.verifiedMs <= nowMs && row.verifiedMs + positiveLifetimeMs > nowMs
        ? { state: 'available', verifiedAtMs: row.verifiedMs }
        : { state: 'unknown' };
    },
    getCoverage({ anidbId, episodeIds, nowMs }) {
      if (!validId(anidbId) || !validTime(nowMs) ||
          !Array.isArray(episodeIds) ||
          episodeIds.length > 10_000 || episodeIds.some((id) => !validId(id)) ||
          new Set(episodeIds).size !== episodeIds.length) {
        throw new TypeError('Invalid availability coverage query');
      }
      if (episodeIds.length === 0) return { verifiedTargets: 0, targetCount: 0 };
      const rows = positiveForAnime.all(anidbId,
        nowMs - positiveLifetimeMs, nowMs);
      const positives = rows.length > 10_000 ? new Set() :
        new Set(rows.map((row) => row.episodeId));
      return { verifiedTargets: episodeIds.filter((id) => positives.has(id)).length,
        targetCount: episodeIds.length };
    },
    getRecentAvailableIds({ anidbId, nowMs }) {
      if (!validId(anidbId) || !validTime(nowMs)) {
        throw new TypeError('Invalid availability coverage query');
      }
      const rows = positiveForAnime.all(anidbId,
        nowMs - positiveLifetimeMs, nowMs);
      return rows.length > 10_000 ? [] : rows.map((row) => row.episodeId);
    },
    claimNext({ nowMs }) {
      if (!validTime(nowMs)) throw new TypeError('Invalid availability clock');
      let begun = false;
      try {
        db.exec('BEGIN IMMEDIATE'); begun = true;
        const row = due.get(nowMs);
        if (!row) { db.exec('COMMIT'); begun = false; return { state: 'idle' }; }
        const updated = claim.run(nowMs + leaseMs, row.anidbId,
          row.episodeId, row.version);
        db.exec('COMMIT'); begun = false;
        if (updated.changes !== 1) return { state: 'idle' };
        return { state: 'claimed', target: { anidbId: row.anidbId,
          episodeId: row.episodeId }, observedMs: row.observedMs,
          version: row.version + 1 };
      } catch (error) { if (begun) db.exec('ROLLBACK'); throw error; }
    },
    recordResult({ claim: receipt, state, checkedMs }) {
      if (receipt?.state !== 'claimed' || !validId(receipt.target?.anidbId) ||
          !validId(receipt.target?.episodeId) || !validTime(receipt.observedMs) ||
          !validId(receipt.version) || !['available', 'unknown'].includes(state) ||
          !validTime(checkedMs)) throw new TypeError('Invalid availability result');
      if (checkedMs < receipt.observedMs) {
        return { state: 'held', reason: 'clock_regressed' };
      }
      const dueMs = checkedMs + (state === 'available'
        ? positiveLifetimeMs : retryMs);
      const updated = record.run(state, dueMs,
        state === 'available' ? checkedMs : null,
        receipt.target.anidbId, receipt.target.episodeId,
        receipt.observedMs, receipt.version);
      return updated.changes === 1 ? { state: 'recorded' } :
        { state: 'held', reason: 'stale_claim' };
    },
    close() { db.close(); },
  };
}

// An explicit tick checks one target. No automatic timer or broad Plex scan.
export function createDirectAvailabilityWorker({ queue, observeTarget,
  now = Date.now } = {}) {
  if (typeof queue?.claimNext !== 'function' ||
      typeof queue?.recordResult !== 'function' ||
      typeof observeTarget !== 'function' || typeof now !== 'function') {
    throw new TypeError('Invalid direct availability worker');
  }
  let busy = false;
  return {
    async runOnce() {
      if (busy) return { state: 'held', reason: 'check_in_progress' };
      busy = true;
      try {
        const receipt = queue.claimNext({ nowMs: now() });
        if (receipt.state === 'idle') return receipt;
        let outcome;
        try { outcome = await observeTarget(receipt.target); }
        catch { outcome = { state: 'unknown' }; }
        const state = outcome?.state === 'available' ? 'available' : 'unknown';
        const saved = queue.recordResult({ claim: receipt, state,
          checkedMs: now() });
        return saved.state === 'recorded'
          ? { state: 'checked', target: receipt.target, result: state }
          : saved;
      } finally { busy = false; }
    },
  };
}
