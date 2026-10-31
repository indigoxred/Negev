import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const held = (reason) => ({ state: 'held', reason });
const validTime = (value) => Number.isSafeInteger(value) && value >= 0;
const validId = (value) => Number.isSafeInteger(value) && value > 0;

// Durable intent only. A future dispatcher must write dispatch_unknown before
// any external call and reconcile an uncertain response without re-sending.
export function openAcquisitionLedger(dbPath) {
  if (typeof dbPath !== 'string' || !dbPath || dbPath === ':memory:') {
    throw new TypeError('A durable request database path is required');
  }
  const db = new DatabaseSync(dbPath, { timeout: 5_000 });
  try {
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA foreign_keys=ON');
    if (!db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='requests'").get()) {
      throw new TypeError('Request ledger must be initialized first');
    }
    db.exec(`CREATE TABLE IF NOT EXISTS acquisition_attempts (
      id INTEGER PRIMARY KEY,
      request_id INTEGER NOT NULL REFERENCES requests(id),
      anidb_id INTEGER NOT NULL CHECK(anidb_id > 0),
      indexer_id INTEGER NOT NULL CHECK(indexer_id > 0),
      candidate_digest TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('reserved','dispatch_unknown','torrent_observed')),
      torrent_hash TEXT,
      created_ms INTEGER NOT NULL CHECK(created_ms >= 0),
      updated_ms INTEGER NOT NULL CHECK(updated_ms >= created_ms),
      UNIQUE(indexer_id,candidate_digest)
    ) STRICT`);
    db.exec(`CREATE TABLE IF NOT EXISTS acquisition_target_claims (
      attempt_id INTEGER NOT NULL REFERENCES acquisition_attempts(id),
      anidb_id INTEGER NOT NULL CHECK(anidb_id > 0),
      episode_id INTEGER NOT NULL CHECK(episode_id > 0),
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      PRIMARY KEY(attempt_id,episode_id)
    ) STRICT`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS active_acquisition_target
      ON acquisition_target_claims(anidb_id,episode_id) WHERE active=1`);
  } catch (error) { db.close(); throw error; }

  const requestRow = db.prepare('SELECT id,anidb_id,status FROM requests WHERE id=?');
  const requestEpisodes = db.prepare(`SELECT t.episode_id FROM targets t
    JOIN request_targets rt ON rt.target_id=t.id WHERE rt.request_id=? ORDER BY t.episode_id`);
  const candidateRow = db.prepare('SELECT id,request_id,anidb_id,status FROM acquisition_attempts WHERE indexer_id=? AND candidate_digest=?');
  const busyTarget = db.prepare('SELECT attempt_id FROM acquisition_target_claims WHERE anidb_id=? AND episode_id=? AND active=1');
  const insertAttempt = db.prepare(`INSERT INTO acquisition_attempts
    (request_id,anidb_id,indexer_id,candidate_digest,status,created_ms,updated_ms)
    VALUES (?,?,?,?,'reserved',?,?)`);
  const claimTarget = db.prepare('INSERT INTO acquisition_target_claims(attempt_id,anidb_id,episode_id) VALUES (?,?,?)');
  const findAttempt = db.prepare(`SELECT id,request_id,anidb_id,status,torrent_hash,created_ms,updated_ms
    FROM acquisition_attempts WHERE id=?`);
  const attemptEpisodes = db.prepare('SELECT episode_id FROM acquisition_target_claims WHERE attempt_id=? ORDER BY episode_id');
  const begin = db.prepare("UPDATE acquisition_attempts SET status='dispatch_unknown',updated_ms=? WHERE id=? AND status='reserved'");
  const observe = db.prepare("UPDATE acquisition_attempts SET status='torrent_observed',torrent_hash=?,updated_ms=? WHERE id=? AND status='dispatch_unknown'");

  function transact(action) {
    let begun = false;
    try {
      db.exec('BEGIN IMMEDIATE');
      begun = true;
      const result = action();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      if (begun) db.exec('ROLLBACK');
      throw error;
    }
  }

  return {
    reserve({ requestId, candidate, nowMs }) {
      if (!validId(requestId) || !validTime(nowMs) ||
          !validId(candidate?.indexerId) || typeof candidate.guid !== 'string' ||
          !candidate.guid || candidate.guid.length > 500) {
        throw new TypeError('Invalid acquisition reservation');
      }
      const digest = createHash('sha256').update(candidate.guid).digest('hex');
      return transact(() => {
        const request = requestRow.get(requestId);
        if (!request || request.status !== 'held') return held('request_missing');
        const episodes = requestEpisodes.all(requestId).map((row) => row.episode_id);
        if (episodes.length === 0 || episodes.length > 500) return held('invalid_request_targets');
        const existing = candidateRow.get(candidate.indexerId, digest);
        if (existing) return existing.request_id === requestId && existing.anidb_id === request.anidb_id
          ? { state: 'existing', attemptId: existing.id, status: existing.status }
          : held('candidate_claimed');
        if (episodes.some((id) => busyTarget.get(request.anidb_id, id))) return held('target_busy');
        const id = Number(insertAttempt.run(requestId, request.anidb_id, candidate.indexerId,
          digest, nowMs, nowMs).lastInsertRowid);
        for (const episodeId of episodes) claimTarget.run(id, request.anidb_id, episodeId);
        return { state: 'reserved', attemptId: id };
      });
    },
    beginDispatch({ attemptId, nowMs }) {
      if (!validId(attemptId) || !validTime(nowMs)) throw new TypeError('Invalid dispatch intent');
      return transact(() => {
        const row = findAttempt.get(attemptId);
        if (!row) return held('attempt_missing');
        if (nowMs < row.updated_ms) return held('time_before_last_transition');
        if (row.status === 'reserved') {
          begin.run(nowMs, attemptId);
          return { state: 'dispatch_unknown', sendNow: true };
        }
        return { state: row.status, sendNow: false };
      });
    },
    recordTorrent({ attemptId, hash, nowMs }) {
      if (!validId(attemptId) || typeof hash !== 'string' ||
          !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(hash) ||
          !validTime(nowMs)) throw new TypeError('Invalid torrent observation');
      return transact(() => {
        const row = findAttempt.get(attemptId);
        if (!row) return held('attempt_missing');
        if (nowMs < row.updated_ms) return held('time_before_last_transition');
        if (row.status === 'torrent_observed') return row.torrent_hash === hash.toLowerCase()
          ? { state: 'torrent_observed' } : held('torrent_conflict');
        if (row.status !== 'dispatch_unknown') return held('dispatch_not_recorded');
        observe.run(hash.toLowerCase(), nowMs, attemptId);
        return { state: 'torrent_observed' };
      });
    },
    getAttempt(attemptId) {
      if (!validId(attemptId)) throw new TypeError('Invalid attempt ID');
      const row = findAttempt.get(attemptId);
      return row ? { id: row.id, requestId: row.request_id, anidbId: row.anidb_id,
        episodeIds: attemptEpisodes.all(attemptId).map((target) => target.episode_id),
        status: row.status, torrentHash: row.torrent_hash } : null;
    },
    close() { db.close(); },
  };
}
