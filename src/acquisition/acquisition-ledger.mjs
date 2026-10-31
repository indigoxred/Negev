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
      expected_hash TEXT,
      torrent_hash TEXT,
      created_ms INTEGER NOT NULL CHECK(created_ms >= 0),
      updated_ms INTEGER NOT NULL CHECK(updated_ms >= created_ms),
      UNIQUE(indexer_id,candidate_digest)
    ) STRICT`);
    // A prior diagnostic ledger may lack the hash column. Such attempts stay
    // held; they are never upgraded into a second send.
    if (!db.prepare('PRAGMA table_info(acquisition_attempts)').all()
      .some((column) => column.name === 'expected_hash')) {
      db.exec('ALTER TABLE acquisition_attempts ADD COLUMN expected_hash TEXT');
    }
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS acquisition_expected_hash
      ON acquisition_attempts(expected_hash) WHERE expected_hash IS NOT NULL`);
    db.exec(`CREATE TABLE IF NOT EXISTS acquisition_target_claims (
      attempt_id INTEGER NOT NULL REFERENCES acquisition_attempts(id),
      anidb_id INTEGER NOT NULL CHECK(anidb_id > 0),
      episode_id INTEGER NOT NULL CHECK(episode_id > 0),
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      PRIMARY KEY(attempt_id,episode_id)
    ) STRICT`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS active_acquisition_target
      ON acquisition_target_claims(anidb_id,episode_id) WHERE active=1`);
    db.exec(`CREATE TABLE IF NOT EXISTS acquisition_releases (
      attempt_id INTEGER PRIMARY KEY REFERENCES acquisition_attempts(id),
      released_ms INTEGER NOT NULL CHECK(released_ms >= 0)
    ) STRICT`);
    db.exec(`CREATE TABLE IF NOT EXISTS acquisition_starts (
      attempt_id INTEGER PRIMARY KEY REFERENCES acquisition_attempts(id),
      torrent_hash TEXT NOT NULL,
      manifest_digest TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('start_unknown','started_observed')),
      created_ms INTEGER NOT NULL CHECK(created_ms >= 0),
      updated_ms INTEGER NOT NULL CHECK(updated_ms >= created_ms)
    ) STRICT`);
  } catch (error) { db.close(); throw error; }

  const requestRow = db.prepare('SELECT id,anidb_id,status FROM requests WHERE id=?');
  const requestedEpisode = db.prepare(`SELECT 1 AS present FROM request_targets rt
    JOIN targets t ON t.id=rt.target_id
    WHERE rt.request_id=? AND t.anidb_id=? AND t.episode_id=? LIMIT 1`);
  const candidateRow = db.prepare('SELECT id,request_id,anidb_id,status FROM acquisition_attempts WHERE indexer_id=? AND candidate_digest=?');
  const busyTarget = db.prepare('SELECT attempt_id FROM acquisition_target_claims WHERE anidb_id=? AND episode_id=? AND active=1');
  const busyHash = db.prepare('SELECT id FROM acquisition_attempts WHERE expected_hash=? AND id<>?');
  const insertAttempt = db.prepare(`INSERT INTO acquisition_attempts
    (request_id,anidb_id,indexer_id,candidate_digest,status,created_ms,updated_ms)
    VALUES (?,?,?,?,'reserved',?,?)`);
  const claimTarget = db.prepare('INSERT INTO acquisition_target_claims(attempt_id,anidb_id,episode_id) VALUES (?,?,?)');
  const findAttempt = db.prepare(`SELECT id,request_id,anidb_id,indexer_id,candidate_digest,status,expected_hash,torrent_hash,created_ms,updated_ms
    FROM acquisition_attempts WHERE id=?`);
  const attemptEpisodes = db.prepare('SELECT episode_id FROM acquisition_target_claims WHERE attempt_id=? ORDER BY episode_id');
  const findRelease = db.prepare('SELECT released_ms FROM acquisition_releases WHERE attempt_id=?');
  const insertRelease = db.prepare('INSERT INTO acquisition_releases(attempt_id,released_ms) VALUES (?,?)');
  const deactivateClaims = db.prepare('UPDATE acquisition_target_claims SET active=0 WHERE attempt_id=? AND active=1');
  const prepare = db.prepare("UPDATE acquisition_attempts SET expected_hash=?,updated_ms=? WHERE id=? AND status='reserved' AND expected_hash IS NULL");
  const begin = db.prepare("UPDATE acquisition_attempts SET status='dispatch_unknown',updated_ms=? WHERE id=? AND status='reserved' AND expected_hash IS NOT NULL");
  const observe = db.prepare("UPDATE acquisition_attempts SET status='torrent_observed',torrent_hash=?,updated_ms=? WHERE id=? AND status='dispatch_unknown'");
  const findStart = db.prepare('SELECT torrent_hash,manifest_digest,status,updated_ms FROM acquisition_starts WHERE attempt_id=?');
  const insertStart = db.prepare(`INSERT INTO acquisition_starts
    (attempt_id,torrent_hash,manifest_digest,status,created_ms,updated_ms)
    VALUES (?,?,?,'start_unknown',?,?)`);

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
    reserve({ requestId, candidate, episodeIds, nowMs }) {
      if (!validId(requestId) || !validTime(nowMs) ||
          !validId(candidate?.indexerId) || typeof candidate.guid !== 'string' ||
          !candidate.guid || candidate.guid.length > 500 ||
          !Array.isArray(episodeIds) || episodeIds.length === 0 || episodeIds.length > 50 ||
          episodeIds.some((id) => !validId(id)) ||
          new Set(episodeIds).size !== episodeIds.length) {
        throw new TypeError('Invalid acquisition reservation');
      }
      const digest = createHash('sha256').update(candidate.guid).digest('hex');
      return transact(() => {
        const request = requestRow.get(requestId);
        if (!request || request.status !== 'held') return held('request_missing');
        if (episodeIds.some((id) => !requestedEpisode.get(requestId, request.anidb_id, id))) {
          return held('target_not_requested');
        }
        const existing = candidateRow.get(candidate.indexerId, digest);
        if (existing && findRelease.get(existing.id)) return held('candidate_released');
        if (existing) return existing.request_id === requestId && existing.anidb_id === request.anidb_id &&
          JSON.stringify(attemptEpisodes.all(existing.id).map((row) => row.episode_id)) ===
          JSON.stringify([...episodeIds].sort((a, b) => a - b))
          ? { state: 'existing', attemptId: existing.id, status: existing.status }
          : held('candidate_claimed');
        if (episodeIds.some((id) => busyTarget.get(request.anidb_id, id))) return held('target_busy');
        const id = Number(insertAttempt.run(requestId, request.anidb_id, candidate.indexerId,
          digest, nowMs, nowMs).lastInsertRowid);
        for (const episodeId of episodeIds) claimTarget.run(id, request.anidb_id, episodeId);
        return { state: 'reserved', attemptId: id };
      });
    },
    releaseReserved({ attemptId, nowMs }) {
      if (!validId(attemptId) || !validTime(nowMs)) throw new TypeError('Invalid release intent');
      return transact(() => {
        const row = findAttempt.get(attemptId);
        if (!row) return held('attempt_missing');
        if (findRelease.get(attemptId)) return { state: 'released_pre_dispatch' };
        if (nowMs < row.updated_ms) return held('time_before_last_transition');
        if (row.status !== 'reserved' || row.expected_hash !== null || findStart.get(attemptId)) {
          return held('candidate_bound_or_sent');
        }
        insertRelease.run(attemptId, nowMs);
        deactivateClaims.run(attemptId);
        return { state: 'released_pre_dispatch' };
      });
    },
    bindPreparedTorrent({ attemptId, candidate, hash, nowMs }) {
      if (!validId(attemptId) || !validId(candidate?.indexerId) ||
          typeof candidate.guid !== 'string' || !candidate.guid || candidate.guid.length > 500 ||
          typeof hash !== 'string' || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(hash) ||
          !validTime(nowMs)) throw new TypeError('Invalid prepared torrent');
      return transact(() => {
        const row = findAttempt.get(attemptId);
        if (!row) return held('attempt_missing');
        if (findRelease.get(attemptId)) return held('candidate_released');
        if (nowMs < row.updated_ms) return held('time_before_last_transition');
        const digest = createHash('sha256').update(candidate.guid).digest('hex');
        if (row.indexer_id !== candidate.indexerId || row.candidate_digest !== digest) {
          return held('candidate_mismatch');
        }
        const normalizedHash = hash.toLowerCase();
        if (row.expected_hash && row.expected_hash !== normalizedHash) return held('torrent_conflict');
        if (busyHash.get(normalizedHash, attemptId)) return held('torrent_claimed');
        if (row.status === 'reserved' && !row.expected_hash) {
          prepare.run(normalizedHash, nowMs, attemptId);
          return { state: 'prepared', expectedHash: normalizedHash };
        }
        if (row.status === 'reserved') return { state: 'prepared', expectedHash: normalizedHash };
        return { state: row.status, expectedHash: normalizedHash };
      });
    },
    beginDispatch({ attemptId, nowMs }) {
      if (!validId(attemptId) || !validTime(nowMs)) throw new TypeError('Invalid dispatch intent');
      return transact(() => {
        const row = findAttempt.get(attemptId);
        if (!row) return held('attempt_missing');
        if (findRelease.get(attemptId)) return held('candidate_released');
        if (nowMs < row.updated_ms) return held('time_before_last_transition');
        if (row.status === 'reserved' && !row.expected_hash) return held('torrent_not_prepared');
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
        if (findRelease.get(attemptId)) return held('candidate_released');
        if (nowMs < row.updated_ms) return held('time_before_last_transition');
        if (!row.expected_hash || row.expected_hash !== hash.toLowerCase()) return held('torrent_conflict');
        if (row.status === 'torrent_observed') return row.torrent_hash === hash.toLowerCase()
          ? { state: 'torrent_observed' } : held('torrent_conflict');
        if (row.status !== 'dispatch_unknown') return held('dispatch_not_recorded');
        observe.run(hash.toLowerCase(), nowMs, attemptId);
        return { state: 'torrent_observed' };
      });
    },
    beginStart({ attemptId, hash, manifestDigest, nowMs }) {
      if (!validId(attemptId) || typeof hash !== 'string' ||
          !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(hash) ||
          typeof manifestDigest !== 'string' || !/^[0-9a-f]{64}$/i.test(manifestDigest) ||
          !validTime(nowMs)) throw new TypeError('Invalid start intent');
      return transact(() => {
        const row = findAttempt.get(attemptId);
        if (!row) return held('attempt_missing');
        if (findRelease.get(attemptId)) return held('candidate_released');
        if (nowMs < row.updated_ms) return held('time_before_last_transition');
        const normalizedHash = hash.toLowerCase();
        const normalizedDigest = manifestDigest.toLowerCase();
        if (row.expected_hash && row.expected_hash !== normalizedHash) return held('torrent_conflict');
        if (row.status !== 'torrent_observed' || row.torrent_hash !== normalizedHash) {
          return held('torrent_not_observed');
        }
        const existing = findStart.get(attemptId);
        if (existing) {
          if (existing.torrent_hash !== normalizedHash) return held('torrent_conflict');
          if (existing.manifest_digest !== normalizedDigest) return held('start_manifest_conflict');
          return { state: existing.status, sendNow: false };
        }
        insertStart.run(attemptId, normalizedHash, normalizedDigest, nowMs, nowMs);
        return { state: 'start_unknown', sendNow: true };
      });
    },
    getStart(attemptId) {
      if (!validId(attemptId)) throw new TypeError('Invalid attempt ID');
      const row = findStart.get(attemptId);
      return row ? { status: row.status, torrentHash: row.torrent_hash,
        manifestDigest: row.manifest_digest } : null;
    },
    getAttempt(attemptId) {
      if (!validId(attemptId)) throw new TypeError('Invalid attempt ID');
      const row = findAttempt.get(attemptId);
      return row ? { id: row.id, requestId: row.request_id, anidbId: row.anidb_id,
        episodeIds: attemptEpisodes.all(attemptId).map((target) => target.episode_id),
        status: findRelease.get(attemptId) ? 'released_pre_dispatch' : row.status,
        expectedHash: row.expected_hash, torrentHash: row.torrent_hash } : null;
    },
    close() { db.close(); },
  };
}
