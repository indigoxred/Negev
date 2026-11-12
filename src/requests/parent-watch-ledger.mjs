import { DatabaseSync } from 'node:sqlite';

const validId = (value) => Number.isSafeInteger(value) && value > 0;
const validTime = (value) => Number.isSafeInteger(value) && value >= 0;
const held = (reason) => ({ state: 'held', reason });

// A parent watch records migration intent. It never dispatches an acquisition;
// a separate reconciler must submit an exact AniDB installment to the normal
// request ledger, where the Sonarr ownership gate still applies.
export function openParentWatchLedger(dbPath) {
  if (typeof dbPath !== 'string' || !dbPath || dbPath === ':memory:') {
    throw new TypeError('Durable parent watch database path required');
  }
  const db = new DatabaseSync(dbPath, { timeout: 5_000 });
  try {
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA foreign_keys=ON');
    db.exec(`CREATE TABLE IF NOT EXISTS parent_watches (
      tvdb_id INTEGER PRIMARY KEY CHECK(tvdb_id>0),
      requester_id INTEGER NOT NULL CHECK(requester_id>0),
      source_series_id INTEGER NOT NULL CHECK(source_series_id>0),
      enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
      created_ms INTEGER NOT NULL CHECK(created_ms>=0),
      updated_ms INTEGER NOT NULL CHECK(updated_ms>=0)
    ) STRICT`);
    db.exec(`CREATE TABLE IF NOT EXISTS parent_watch_installments (
      anidb_id INTEGER PRIMARY KEY CHECK(anidb_id>0),
      tvdb_id INTEGER NOT NULL REFERENCES parent_watches(tvdb_id),
      request_id INTEGER CHECK(request_id>0),
      recorded_ms INTEGER NOT NULL CHECK(recorded_ms>=0)
    ) STRICT`);
    db.exec(`CREATE TABLE IF NOT EXISTS parent_watch_cursor (
      id INTEGER PRIMARY KEY CHECK(id=1),
      after_tvdb_id INTEGER NOT NULL CHECK(after_tvdb_id>=0)
    ) STRICT`);
    db.exec('INSERT INTO parent_watch_cursor(id,after_tvdb_id) VALUES (1,0) ON CONFLICT(id) DO NOTHING');
  } catch (error) { db.close(); throw error; }
  const parent = db.prepare('SELECT * FROM parent_watches WHERE tvdb_id=?');
  const installment = db.prepare('SELECT * FROM parent_watch_installments WHERE anidb_id=?');
  const listActive = db.prepare(`SELECT tvdb_id AS tvdbId,requester_id AS requesterId,
    source_series_id AS sourceSeriesId FROM parent_watches
    WHERE enabled=1 AND tvdb_id>? ORDER BY tvdb_id LIMIT ?`);
  const listInstallments = db.prepare(`SELECT anidb_id AS anidbId,request_id AS requestId
    FROM parent_watch_installments WHERE tvdb_id=? ORDER BY anidb_id`);
  const cursor = db.prepare('SELECT after_tvdb_id AS tvdbId FROM parent_watch_cursor WHERE id=1');
  const transact = (action) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      db.exec('COMMIT');
      return result;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const setEnabled = (tvdbId, enabled, nowMs) => {
    if (!validId(tvdbId) || !validTime(nowMs)) throw new TypeError('Invalid parent watch');
    return transact(() => {
      if (!parent.get(tvdbId)) return held('parent_missing');
      db.prepare('UPDATE parent_watches SET enabled=?,updated_ms=? WHERE tvdb_id=?')
        .run(Number(enabled), nowMs, tvdbId);
      return { state: enabled ? 'active' : 'paused' };
    });
  };
  return {
    adopt({ tvdbId, requesterId, sourceSeriesId, nowMs } = {}) {
      if (![tvdbId, requesterId, sourceSeriesId].every(validId) || !validTime(nowMs)) {
        throw new TypeError('Invalid parent watch adoption');
      }
      return transact(() => {
        const existing = parent.get(tvdbId);
        if (existing) return existing.requester_id === requesterId &&
          existing.source_series_id === sourceSeriesId
          ? { state: 'adopted', created: false }
          : held('parent_source_conflict');
        db.prepare(`INSERT INTO parent_watches
          (tvdb_id,requester_id,source_series_id,enabled,created_ms,updated_ms)
          VALUES (?,?,?,1,?,?)`).run(tvdbId, requesterId, sourceSeriesId, nowMs, nowMs);
        return { state: 'adopted', created: true };
      });
    },
    pause({ tvdbId, nowMs } = {}) { return setEnabled(tvdbId, false, nowMs); },
    resume({ tvdbId, nowMs } = {}) { return setEnabled(tvdbId, true, nowMs); },
    listActive({ afterTvdbId = 0, limit = 20 } = {}) {
      if (!Number.isSafeInteger(afterTvdbId) || afterTvdbId < 0 ||
          !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new TypeError('Invalid parent watch page');
      }
      return listActive.all(afterTvdbId, limit).map((row) => ({ ...row }));
    },
    listInstallments({ tvdbId } = {}) {
      if (!validId(tvdbId)) throw new TypeError('Invalid parent ID');
      return listInstallments.all(tvdbId).map((row) => ({ ...row }));
    },
    claimInstallment({ tvdbId, anidbId, nowMs } = {}) {
      if (![tvdbId, anidbId].every(validId) || !validTime(nowMs)) {
        throw new TypeError('Invalid parent installment claim');
      }
      return transact(() => {
        const owner = parent.get(tvdbId);
        if (!owner) return held('parent_missing');
        if (!owner.enabled) return held('parent_paused');
        const existing = installment.get(anidbId);
        if (existing) return existing.tvdb_id === tvdbId
          ? { state: 'claimed', created: false }
          : held('installment_parent_conflict');
        db.prepare(`INSERT INTO parent_watch_installments
          (anidb_id,tvdb_id,request_id,recorded_ms) VALUES (?,?,NULL,?)`)
          .run(anidbId, tvdbId, nowMs);
        return { state: 'claimed', created: true };
      });
    },
    recordInstallment({ tvdbId, anidbId, requestId, nowMs } = {}) {
      if (![tvdbId, anidbId, requestId].every(validId) || !validTime(nowMs)) {
        throw new TypeError('Invalid parent installment');
      }
      return transact(() => {
        const owner = parent.get(tvdbId);
        if (!owner) return held('parent_missing');
        if (!owner.enabled) return held('parent_paused');
        const existing = installment.get(anidbId);
        if (existing) {
          if (existing.tvdb_id !== tvdbId ||
              existing.request_id !== null && existing.request_id !== requestId) {
            return held('installment_parent_conflict');
          }
          if (existing.request_id === null) {
            db.prepare(`UPDATE parent_watch_installments SET request_id=?,recorded_ms=?
              WHERE anidb_id=? AND tvdb_id=? AND request_id IS NULL`)
              .run(requestId, nowMs, anidbId, tvdbId);
          }
          return { state: 'recorded', created: existing.request_id === null };
        }
        db.prepare(`INSERT INTO parent_watch_installments
          (anidb_id,tvdb_id,request_id,recorded_ms) VALUES (?,?,?,?)`)
          .run(anidbId, tvdbId, requestId, nowMs);
        return { state: 'recorded', created: true };
      });
    },
    getCursor() { return cursor.get().tvdbId; },
    advanceCursor({ expectedTvdbId, nextTvdbId } = {}) {
      if (![expectedTvdbId, nextTvdbId].every((id) =>
        Number.isSafeInteger(id) && id >= 0) ||
        (nextTvdbId !== 0 && nextTvdbId <= expectedTvdbId)) {
        throw new TypeError('Invalid parent watch cursor');
      }
      const changes = db.prepare(`UPDATE parent_watch_cursor SET after_tvdb_id=?
        WHERE id=1 AND after_tvdb_id=?`).run(nextTvdbId, expectedTvdbId).changes;
      return changes === 1 ? { state: 'advanced', tvdbId: nextTvdbId }
        : held('stale_cursor');
    },
    close() { db.close(); },
  };
}
