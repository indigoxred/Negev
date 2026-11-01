import { DatabaseSync } from 'node:sqlite';

const validId = (value) => Number.isSafeInteger(value) && value > 0;
const validTime = (value) => Number.isSafeInteger(value) && value >= 0;
const validProof = (proof) => validId(proof?.fileId) &&
  validId(proof.libraryId) && validId(proof.ratingKey) &&
  validId(proof.partId);
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
      proof_file_id INTEGER,
      proof_library_id INTEGER,
      proof_rating_key INTEGER,
      proof_part_id INTEGER,
      PRIMARY KEY(anidb_id,episode_id)
    ) STRICT`);
    const columns = new Set(db.prepare(`PRAGMA table_info(direct_availability_targets)`)
      .all().map((column) => column.name));
    for (const [name, declaration] of [
      ['priority', 'INTEGER NOT NULL DEFAULT 0 CHECK(priority IN (0,1))'],
      ['proof_file_id', 'INTEGER'], ['proof_library_id', 'INTEGER'],
      ['proof_rating_key', 'INTEGER'], ['proof_part_id', 'INTEGER'],
    ]) {
      if (!columns.has(name)) db.exec(`ALTER TABLE direct_availability_targets
        ADD COLUMN ${name} ${declaration}`);
    }
    db.exec(`CREATE TABLE IF NOT EXISTS plex_card_change_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      library_id INTEGER NOT NULL CHECK(library_id>0),
      rating_key INTEGER NOT NULL CHECK(rating_key>0),
      observed_ms INTEGER NOT NULL CHECK(observed_ms>=0)
    ) STRICT`);
    db.exec(`CREATE INDEX IF NOT EXISTS plex_change_card
      ON plex_card_change_events(library_id,rating_key,id)`);
    db.exec(`CREATE TABLE IF NOT EXISTS shoko_file_change_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER NOT NULL CHECK(file_id>0),
      observed_ms INTEGER NOT NULL CHECK(observed_ms>=0)
    ) STRICT`);
    db.exec(`CREATE INDEX IF NOT EXISTS shoko_change_file
      ON shoko_file_change_events(file_id,id)`);
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
    state='pending',verified_ms=NULL,proof_file_id=NULL,
    proof_library_id=NULL,proof_rating_key=NULL,proof_part_id=NULL
    WHERE anidb_id=? AND episode_id=? AND observed_ms<=?`);
  const due = db.prepare(`SELECT anidb_id AS anidbId,episode_id AS episodeId,
    observed_ms AS observedMs,version FROM direct_availability_targets
    WHERE due_ms<=? ORDER BY priority DESC,due_ms,anidb_id,episode_id LIMIT 1`);
  const claim = db.prepare(`UPDATE direct_availability_targets SET
    state='checking',due_ms=?,version=version+1,priority=0,verified_ms=NULL,
    proof_file_id=NULL,proof_library_id=NULL,proof_rating_key=NULL,
    proof_part_id=NULL
    WHERE anidb_id=? AND episode_id=? AND version=?`);
  const record = db.prepare(`UPDATE direct_availability_targets SET
    state=?,due_ms=?,verified_ms=?,proof_file_id=?,proof_library_id=?,
    proof_rating_key=?,proof_part_id=? WHERE anidb_id=? AND episode_id=?
    AND observed_ms=? AND version=? AND state='checking'`);
  const latestChange = db.prepare(`SELECT COALESCE(MAX(id),0) AS id
    FROM plex_card_change_events`);
  const latestShokoChange = db.prepare(`SELECT COALESCE(MAX(id),0) AS id
    FROM shoko_file_change_events`);
  const cardChanged = db.prepare(`SELECT id FROM plex_card_change_events
    WHERE library_id=? AND rating_key=? ORDER BY id DESC LIMIT 1`);
  const shokoChanged = db.prepare(`SELECT id FROM shoko_file_change_events
    WHERE file_id=? ORDER BY id DESC LIMIT 1`);
  const releaseChanged = db.prepare(`UPDATE direct_availability_targets SET
    state='pending',due_ms=?,priority=1,version=version+1
    WHERE anidb_id=? AND episode_id=? AND observed_ms=? AND version=?
      AND state='checking'`);
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
        const changeId = latestChange.get().id;
        const shokoChangeId = latestShokoChange.get().id;
        const updated = claim.run(nowMs + leaseMs, row.anidbId,
          row.episodeId, row.version);
        db.exec('COMMIT'); begun = false;
        if (updated.changes !== 1) return { state: 'idle' };
        return { state: 'claimed', target: { anidbId: row.anidbId,
          episodeId: row.episodeId }, observedMs: row.observedMs,
          version: row.version + 1, startedMs: nowMs, changeId,
          shokoChangeId };
      } catch (error) { if (begun) db.exec('ROLLBACK'); throw error; }
    },
    recordResult({ claim: receipt, state, checkedMs, proof = null }) {
      if (receipt?.state !== 'claimed' || !validId(receipt.target?.anidbId) ||
          !validId(receipt.target?.episodeId) || !validTime(receipt.observedMs) ||
          !validId(receipt.version) || !validTime(receipt.startedMs) ||
          !validTime(receipt.changeId) ||
          !validTime(receipt.shokoChangeId) ||
          !['available', 'unknown'].includes(state) || !validTime(checkedMs) ||
          (proof !== null && (state !== 'available' || !validProof(proof)))) {
        throw new TypeError('Invalid availability result');
      }
      if (checkedMs < receipt.observedMs || checkedMs < receipt.startedMs) {
        return { state: 'held', reason: 'clock_regressed' };
      }
      const dueMs = checkedMs + (state === 'available'
        ? positiveLifetimeMs : retryMs);
      let begun = false;
      try {
        db.exec('BEGIN IMMEDIATE'); begun = true;
        const change = proof && cardChanged.get(proof.libraryId,
          proof.ratingKey);
        const fileChange = proof && shokoChanged.get(proof.fileId);
        if (fileChange && fileChange.id > receipt.shokoChangeId) {
          releaseChanged.run(checkedMs, receipt.target.anidbId,
            receipt.target.episodeId, receipt.observedMs, receipt.version);
          db.exec('COMMIT'); begun = false;
          return { state: 'held', reason: 'shoko_changed' };
        }
        if (change && change.id > receipt.changeId) {
          releaseChanged.run(checkedMs, receipt.target.anidbId,
            receipt.target.episodeId, receipt.observedMs, receipt.version);
          db.exec('COMMIT'); begun = false;
          return { state: 'held', reason: 'card_changed' };
        }
        const updated = record.run(state, dueMs,
          state === 'available' ? checkedMs : null,
          proof?.fileId ?? null, proof?.libraryId ?? null,
          proof?.ratingKey ?? null, proof?.partId ?? null,
          receipt.target.anidbId, receipt.target.episodeId,
          receipt.observedMs, receipt.version);
        db.exec('COMMIT'); begun = false;
        return updated.changes === 1 ? { state: 'recorded' } :
          { state: 'held', reason: 'stale_claim' };
      } catch (error) { if (begun) db.exec('ROLLBACK'); throw error; }
    },
    close() { db.close(); },
  };
}

// An explicit tick checks one target. No automatic timer or broad Plex scan.
export function createDirectAvailabilityWorker({ queue, observeTarget,
  now = Date.now, requireProof = false } = {}) {
  if (typeof queue?.claimNext !== 'function' ||
      typeof queue?.recordResult !== 'function' ||
      typeof observeTarget !== 'function' || typeof now !== 'function' ||
      typeof requireProof !== 'boolean') {
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
        const proof = outcome?.proof;
        const state = outcome?.state === 'available' &&
          (proof == null ? !requireProof : validProof(proof))
          ? 'available' : 'unknown';
        const saved = queue.recordResult({ claim: receipt, state,
          checkedMs: now(), proof: state === 'available'
            ? proof ?? null : null });
        return saved.state === 'recorded'
          ? { state: 'checked', target: receipt.target, result: state }
          : saved;
      } finally { busy = false; }
    },
  };
}
