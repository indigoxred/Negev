import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { torrentFileKind } from './evaluate-stopped-manifest.mjs';
import { MAX_RELEASE_GUID_LENGTH } from './release-candidate-limits.mjs';

const held = (reason) => ({ state: 'held', reason });
const validTime = (value) => Number.isSafeInteger(value) && value >= 0;
const validId = (value) => Number.isSafeInteger(value) && value > 0;
const validHash = (value) => typeof value === 'string' &&
  /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(value);

function canonicalFilePlan(plannedFiles) {
  if (!Array.isArray(plannedFiles) || plannedFiles.length < 1 || plannedFiles.length > 50) {
    throw new TypeError('Invalid acquisition file plan');
  }
  const names = new Set();
  const targets = new Set();
  const files = plannedFiles.map((file) => {
    if (typeof file?.name !== 'string' || file.name.length > 1000 ||
        torrentFileKind(file.name) !== 'video' ||
        !Number.isSafeInteger(file.size) || file.size < 1 || file.size > 1024 ** 4 ||
        !Array.isArray(file.episodeIds) || file.episodeIds.length < 1 ||
        file.episodeIds.length > 50 || file.episodeIds.some((id) => !validId(id))) {
      throw new TypeError('Invalid acquisition file plan');
    }
    const nameKey = file.name.toLowerCase();
    if (names.has(nameKey)) throw new TypeError('Duplicate acquisition filename');
    names.add(nameKey);
    for (const id of file.episodeIds) {
      if (targets.has(id)) throw new TypeError('Duplicate acquisition target');
      targets.add(id);
    }
    return { name: file.name, size: file.size,
      episodeIds: [...file.episodeIds].sort((a, b) => a - b) };
  });
  files.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return { files, targetIds: [...targets].sort((a, b) => a - b) };
}

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
      evidence_policy TEXT NOT NULL DEFAULT 'strict' CHECK(evidence_policy IN ('strict','first_time_permissive')),
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
    if (!db.prepare('PRAGMA table_info(acquisition_attempts)').all()
      .some((column) => column.name === 'evidence_policy')) {
      db.exec("ALTER TABLE acquisition_attempts ADD COLUMN evidence_policy TEXT NOT NULL DEFAULT 'strict' CHECK(evidence_policy IN ('strict','first_time_permissive'))");
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
    db.exec(`CREATE TABLE IF NOT EXISTS acquisition_file_plans (
      attempt_id INTEGER NOT NULL REFERENCES acquisition_attempts(id),
      file_name TEXT NOT NULL,
      file_size INTEGER NOT NULL CHECK(file_size > 0),
      episode_key TEXT NOT NULL,
      PRIMARY KEY(attempt_id,file_name)
    ) STRICT`);
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
    db.exec(`CREATE TABLE IF NOT EXISTS acquisition_rejections (
      attempt_id INTEGER PRIMARY KEY REFERENCES acquisition_attempts(id),
      torrent_hash TEXT NOT NULL,
      reason TEXT NOT NULL CHECK(reason = 'file_wrong_identity'),
      rejected_ms INTEGER NOT NULL CHECK(rejected_ms >= 0)
    ) STRICT`);
    db.exec(`CREATE TABLE IF NOT EXISTS acquisition_retirements (
      attempt_id INTEGER PRIMARY KEY REFERENCES acquisition_attempts(id),
      torrent_hash TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT 'file_wrong_identity'
        CHECK(reason IN ('file_wrong_identity','stalled_download')),
      retired_ms INTEGER NOT NULL CHECK(retired_ms >= 0)
    ) STRICT`);
    if (!db.prepare('PRAGMA table_info(acquisition_retirements)').all()
      .some((column) => column.name === 'reason')) {
      db.exec("ALTER TABLE acquisition_retirements ADD COLUMN reason TEXT NOT NULL DEFAULT 'file_wrong_identity' CHECK(reason IN ('file_wrong_identity','stalled_download'))");
    }
    db.exec(`CREATE TABLE IF NOT EXISTS acquisition_stall_retirement_intents (
      attempt_id INTEGER PRIMARY KEY REFERENCES acquisition_attempts(id),
      torrent_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('requested','delete_unknown')),
      created_ms INTEGER NOT NULL CHECK(created_ms >= 0),
      updated_ms INTEGER NOT NULL CHECK(updated_ms >= created_ms)
    ) STRICT`);
  } catch (error) { db.close(); throw error; }

  const requestRow = db.prepare('SELECT id,anidb_id,status FROM requests WHERE id=?');
  const attemptForRequest = db.prepare('SELECT 1 AS present FROM acquisition_attempts WHERE request_id=? LIMIT 1');
  const requestedEpisode = db.prepare(`SELECT 1 AS present FROM request_targets rt
    JOIN targets t ON t.id=rt.target_id
    WHERE rt.request_id=? AND t.anidb_id=? AND t.episode_id=? LIMIT 1`);
  const candidateRow = db.prepare('SELECT id,request_id,anidb_id,status,evidence_policy FROM acquisition_attempts WHERE indexer_id=? AND candidate_digest=?');
  const busyTarget = db.prepare('SELECT attempt_id FROM acquisition_target_claims WHERE anidb_id=? AND episode_id=? AND active=1');
  const historicalTarget = db.prepare(`SELECT claim.attempt_id
    FROM acquisition_target_claims claim
    LEFT JOIN acquisition_releases released ON released.attempt_id=claim.attempt_id
    LEFT JOIN acquisition_retirements retired ON retired.attempt_id=claim.attempt_id
    WHERE claim.anidb_id=? AND claim.episode_id=?
      AND released.attempt_id IS NULL AND retired.attempt_id IS NULL LIMIT 1`);
  const busyHash = db.prepare('SELECT id FROM acquisition_attempts WHERE expected_hash=? AND id<>?');
  const insertAttempt = db.prepare(`INSERT INTO acquisition_attempts
    (request_id,anidb_id,indexer_id,candidate_digest,status,evidence_policy,created_ms,updated_ms)
    VALUES (?,?,?,?,'reserved',?,?,?)`);
  const claimTarget = db.prepare('INSERT INTO acquisition_target_claims(attempt_id,anidb_id,episode_id) VALUES (?,?,?)');
  const findAttempt = db.prepare(`SELECT id,request_id,anidb_id,indexer_id,candidate_digest,status,evidence_policy,expected_hash,torrent_hash,created_ms,updated_ms
    FROM acquisition_attempts WHERE id=?`);
  const attemptEpisodes = db.prepare('SELECT episode_id FROM acquisition_target_claims WHERE attempt_id=? ORDER BY episode_id');
  const activeAttemptEpisodes = db.prepare(`SELECT episode_id FROM acquisition_target_claims
    WHERE attempt_id=? AND active=1 ORDER BY episode_id`);
  const planRows = db.prepare('SELECT file_name,file_size,episode_key FROM acquisition_file_plans WHERE attempt_id=? ORDER BY file_name');
  const insertPlan = db.prepare('INSERT INTO acquisition_file_plans(attempt_id,file_name,file_size,episode_key) VALUES (?,?,?,?)');
  const touchAttempt = db.prepare('UPDATE acquisition_attempts SET updated_ms=? WHERE id=?');
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
  const findRejection = db.prepare('SELECT torrent_hash,reason,rejected_ms FROM acquisition_rejections WHERE attempt_id=?');
  const insertRejection = db.prepare(`INSERT INTO acquisition_rejections
    (attempt_id,torrent_hash,reason,rejected_ms) VALUES (?,?,?,?)`);
  const findRetirement = db.prepare('SELECT torrent_hash,reason,retired_ms FROM acquisition_retirements WHERE attempt_id=?');
  const findStallIntent = db.prepare(`SELECT torrent_hash,status,created_ms,updated_ms
    FROM acquisition_stall_retirement_intents WHERE attempt_id=?`);
  const insertStallIntent = db.prepare(`INSERT INTO acquisition_stall_retirement_intents
    (attempt_id,torrent_hash,status,created_ms,updated_ms)
    VALUES (?,?,'requested',?,?)`);
  const beginStallDelete = db.prepare(`UPDATE acquisition_stall_retirement_intents
    SET status='delete_unknown',updated_ms=?
    WHERE attempt_id=? AND torrent_hash=? AND status='requested'`);
  const cancelStallIntent = db.prepare(`DELETE FROM acquisition_stall_retirement_intents
    WHERE attempt_id=? AND torrent_hash=? AND status='requested'`);
  const rejectedNeedsReview = db.prepare(`SELECT a.id AS attemptId,
    a.request_id AS requestId,a.anidb_id AS anidbId,
    r.reason,r.rejected_ms AS observedMs
    FROM acquisition_rejections r
    JOIN acquisition_attempts a ON a.id=r.attempt_id
    LEFT JOIN acquisition_retirements t ON t.attempt_id=r.attempt_id
    WHERE t.attempt_id IS NULL AND a.id>?
    ORDER BY a.id LIMIT ?`);
  const insertRetirement = db.prepare(`INSERT INTO acquisition_retirements
    (attempt_id,torrent_hash,reason,retired_ms) VALUES (?,?,?,?)`);
  const handoffTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='handoff_intents'");

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
    // Read-only short circuit for a torrent this request already owns. A
    // matching claim can be reported busy without repeating the expensive
    // absence fence; it cannot authorize another dispatch or media action.
    getOwnedObservedCandidate({ requestId, candidate, episodeIds } = {}) {
      if (!validId(requestId) || !validId(candidate?.indexerId) ||
          typeof candidate.guid !== 'string' || !candidate.guid ||
          candidate.guid.length > MAX_RELEASE_GUID_LENGTH ||
          !Array.isArray(episodeIds) || episodeIds.length < 1 ||
          episodeIds.length > 50 || episodeIds.some((id) => !validId(id)) ||
          new Set(episodeIds).size !== episodeIds.length) {
        throw new TypeError('Invalid observed candidate lookup');
      }
      const request = requestRow.get(requestId);
      if (request?.status !== 'held' || episodeIds.some((id) =>
        !requestedEpisode.get(requestId, request.anidb_id, id))) return null;
      const digest = createHash('sha256').update(candidate.guid).digest('hex');
      const existing = candidateRow.get(candidate.indexerId, digest);
      if (existing?.status !== 'torrent_observed' ||
          existing.request_id !== requestId ||
          existing.anidb_id !== request.anidb_id ||
          findRelease.get(existing.id) || findRejection.get(existing.id) ||
          findRetirement.get(existing.id) ||
          JSON.stringify(activeAttemptEpisodes.all(existing.id).map((row) =>
            row.episode_id)) !== JSON.stringify([...episodeIds].sort((a, b) =>
              a - b))) return null;
      return { state: 'owned_observed', attemptId: existing.id };
    },
    listRejectedNeedsReview({ afterAttemptId = 0, limit = 20 } = {}) {
      if (!Number.isSafeInteger(afterAttemptId) || afterAttemptId < 0 ||
          !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
        throw new TypeError('Invalid rejected review page');
      }
      return rejectedNeedsReview.all(afterAttemptId, limit).map((row) => ({ ...row }));
    },
    inspectRequestAttempts(requestId) {
      if (!validId(requestId)) throw new TypeError('Invalid request ID');
      return { state: attemptForRequest.get(requestId) ? 'attempt_present' : 'no_attempt' };
    },
    reserve({ requestId, candidate, episodeIds,
      evidencePolicy = 'strict', nowMs }) {
      if (!validId(requestId) || !validTime(nowMs) ||
          !['strict', 'first_time_permissive'].includes(evidencePolicy) ||
          !validId(candidate?.indexerId) || typeof candidate.guid !== 'string' ||
          !candidate.guid || candidate.guid.length > MAX_RELEASE_GUID_LENGTH ||
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
        if (existing && findRejection.get(existing.id)) return held('candidate_rejected');
        if (existing && findRetirement.get(existing.id)) return held('candidate_retired');
        if (existing) return existing.request_id === requestId && existing.anidb_id === request.anidb_id &&
          existing.evidence_policy === evidencePolicy &&
          JSON.stringify(attemptEpisodes.all(existing.id).map((row) => row.episode_id)) ===
          JSON.stringify([...episodeIds].sort((a, b) => a - b))
          ? { state: 'existing', attemptId: existing.id, status: existing.status }
          : held('candidate_claimed');
        if (evidencePolicy === 'first_time_permissive' &&
            episodeIds.some((id) => historicalTarget.get(request.anidb_id, id))) {
          return held('uncertain_attempt_exhausted');
        }
        if (episodeIds.some((id) => busyTarget.get(request.anidb_id, id))) return held('target_busy');
        const id = Number(insertAttempt.run(requestId, request.anidb_id, candidate.indexerId,
          digest, evidencePolicy, nowMs, nowMs).lastInsertRowid);
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
    // Wrong AniDB identity is a terminal result for this exact candidate.
    // Keep claims active until a separately proved torrent/staging retirement;
    // otherwise a second grab could race with media still on disk.
    recordTerminalRejection({ attemptId, hash, reason, nowMs }) {
      if (!validId(attemptId) || !validHash(hash) ||
          reason !== 'file_wrong_identity' || !validTime(nowMs)) {
        throw new TypeError('Invalid terminal rejection');
      }
      return transact(() => {
        const row = findAttempt.get(attemptId);
        if (!row) return held('attempt_missing');
        if (findRelease.get(attemptId)) return held('candidate_released');
        const normalizedHash = hash.toLowerCase();
        if (row.expected_hash !== normalizedHash || row.torrent_hash !== normalizedHash) {
          return held('torrent_conflict');
        }
        if (findRetirement.get(attemptId)) return { state: 'retired_rejected' };
        const existing = findRejection.get(attemptId);
        if (existing) return existing.torrent_hash === normalizedHash &&
          existing.reason === reason
          ? { state: 'rejected_held', reason } : held('rejection_conflict');
        if (row.status !== 'torrent_observed' ||
            findStart.get(attemptId)?.torrent_hash !== normalizedHash) {
          return held('start_intent_missing');
        }
        if (nowMs < row.updated_ms) return held('time_before_last_transition');
        if (handoffTable.get() && db.prepare(
          'SELECT 1 FROM handoff_intents WHERE attempt_id=?').get(attemptId)) {
          return held('handoff_already_recorded');
        }
        insertRejection.run(attemptId, normalizedHash, reason, nowMs);
        return { state: 'rejected_held', reason };
      });
    },
    // Called only after an authenticated observer has proved that the exact
    // rejected torrent is absent. This ledger transition never touches files.
    retireRejected({ attemptId, hash, nowMs }) {
      if (!validId(attemptId) || !validHash(hash) || !validTime(nowMs)) {
        throw new TypeError('Invalid rejected-torrent retirement');
      }
      return transact(() => {
        const row = findAttempt.get(attemptId);
        if (!row) return held('attempt_missing');
        const normalizedHash = hash.toLowerCase();
        if (row.expected_hash !== normalizedHash || row.torrent_hash !== normalizedHash) {
          return held('torrent_conflict');
        }
        const rejected = findRejection.get(attemptId);
        if (!rejected || rejected.torrent_hash !== normalizedHash) {
          return held('candidate_not_rejected');
        }
        const existing = findRetirement.get(attemptId);
        if (existing) return existing.torrent_hash === normalizedHash
          ? { state: 'retired_rejected' } : held('torrent_conflict');
        if (findRelease.get(attemptId) || nowMs < row.updated_ms ||
            nowMs < rejected.rejected_ms) return held('retirement_conflict');
        if (handoffTable.get() && db.prepare(
          'SELECT 1 FROM handoff_intents WHERE attempt_id=?').get(attemptId)) {
          return held('handoff_already_recorded');
        }
        insertRetirement.run(attemptId, normalizedHash, 'file_wrong_identity', nowMs);
        deactivateClaims.run(attemptId);
        touchAttempt.run(nowMs, attemptId);
        return { state: 'retired_rejected' };
      });
    },
    requestStalledRetirement({ attemptId, hash, nowMs }) {
      if (!validId(attemptId) || !validHash(hash) || !validTime(nowMs)) {
        throw new TypeError('Invalid stalled retirement request');
      }
      return transact(() => {
        const row = findAttempt.get(attemptId);
        if (!row) return held('attempt_missing');
        const normalizedHash = hash.toLowerCase();
        if (row.expected_hash !== normalizedHash ||
            row.torrent_hash !== normalizedHash) return held('torrent_conflict');
        const existing = findStallIntent.get(attemptId);
        if (existing) return existing.torrent_hash === normalizedHash
          ? { state: existing.status === 'requested'
            ? 'retirement_requested' : 'delete_unknown' }
          : held('torrent_conflict');
        if (findRelease.get(attemptId) || findRejection.get(attemptId) ||
            findRetirement.get(attemptId) || row.status !== 'torrent_observed' ||
            findStart.get(attemptId)?.torrent_hash !== normalizedHash ||
            nowMs < row.updated_ms) return held('retirement_conflict');
        if (handoffTable.get() && db.prepare(
          'SELECT 1 FROM handoff_intents WHERE attempt_id=?').get(attemptId)) {
          return held('handoff_already_recorded');
        }
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='completion_checks'").get() &&
            db.prepare(`SELECT 1 FROM completion_checks WHERE attempt_id=? AND
              (state IS NULL OR state <> 'held')`).get(attemptId)) {
          return held('completion_in_progress');
        }
        insertStallIntent.run(attemptId, normalizedHash, nowMs, nowMs);
        return { state: 'retirement_requested' };
      });
    },
    getStalledRetirementIntent(attemptId) {
      if (!validId(attemptId)) throw new TypeError('Invalid attempt ID');
      const row = findStallIntent.get(attemptId);
      return row ? { hash: row.torrent_hash, status: row.status } : null;
    },
    cancelStalledRetirement({ attemptId, hash }) {
      if (!validId(attemptId) || !validHash(hash)) {
        throw new TypeError('Invalid stalled retirement cancellation');
      }
      return transact(() => {
        const row = findStallIntent.get(attemptId);
        if (!row) return { state: 'retirement_cancelled' };
        const normalizedHash = hash.toLowerCase();
        if (row.torrent_hash !== normalizedHash) return held('torrent_conflict');
        if (row.status !== 'requested') return held('delete_already_possible');
        return cancelStallIntent.run(attemptId, normalizedHash).changes === 1
          ? { state: 'retirement_cancelled' } : held('retirement_conflict');
      });
    },
    beginStalledDelete({ attemptId, hash, nowMs }) {
      if (!validId(attemptId) || !validHash(hash) || !validTime(nowMs)) {
        throw new TypeError('Invalid stalled delete intent');
      }
      return transact(() => {
        const row = findStallIntent.get(attemptId);
        const normalizedHash = hash.toLowerCase();
        if (!row) return held('retirement_not_requested');
        if (row.torrent_hash !== normalizedHash) return held('torrent_conflict');
        if (findRetirement.get(attemptId)) return held('already_retired');
        if (row.status === 'delete_unknown') {
          return { state: 'delete_unknown', sendNow: false };
        }
        if (nowMs < row.updated_ms) return held('time_before_last_transition');
        if (beginStallDelete.run(nowMs, attemptId, normalizedHash).changes !== 1) {
          return held('retirement_conflict');
        }
        return { state: 'delete_unknown', sendNow: true };
      });
    },
    // Only a caller that has proved this exact torrent absent and its staging
    // leaf empty may make this transition. No file or provider action occurs here.
    retireStalled({ attemptId, hash, nowMs }) {
      if (!validId(attemptId) || !validHash(hash) || !validTime(nowMs)) {
        throw new TypeError('Invalid stalled-torrent retirement');
      }
      return transact(() => {
        const row = findAttempt.get(attemptId);
        if (!row) return held('attempt_missing');
        const normalizedHash = hash.toLowerCase();
        if (row.expected_hash !== normalizedHash ||
            row.torrent_hash !== normalizedHash) return held('torrent_conflict');
        const existing = findRetirement.get(attemptId);
        if (existing) return existing.torrent_hash === normalizedHash &&
          existing.reason === 'stalled_download'
          ? { state: 'retired_stalled' } : held('retirement_conflict');
        if (findRelease.get(attemptId) || findRejection.get(attemptId) ||
            row.status !== 'torrent_observed' || nowMs < row.updated_ms) {
          return held('retirement_conflict');
        }
        if (findStart.get(attemptId)?.torrent_hash !== normalizedHash) {
          return held('start_intent_missing');
        }
        const intent = findStallIntent.get(attemptId);
        if (intent?.torrent_hash !== normalizedHash) {
          return held('retirement_not_requested');
        }
        if (intent.status !== 'delete_unknown') return held('delete_intent_missing');
        if (handoffTable.get() && db.prepare(
          'SELECT 1 FROM handoff_intents WHERE attempt_id=?').get(attemptId)) {
          return held('handoff_already_recorded');
        }
        insertRetirement.run(attemptId, normalizedHash, 'stalled_download', nowMs);
        deactivateClaims.run(attemptId);
        touchAttempt.run(nowMs, attemptId);
        return { state: 'retired_stalled' };
      });
    },
    bindPreparedTorrent({ attemptId, candidate, hash, nowMs }) {
      if (!validId(attemptId) || !validId(candidate?.indexerId) ||
          typeof candidate.guid !== 'string' || !candidate.guid || candidate.guid.length > MAX_RELEASE_GUID_LENGTH ||
          typeof hash !== 'string' || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(hash) ||
          !validTime(nowMs)) throw new TypeError('Invalid prepared torrent');
      return transact(() => {
        const row = findAttempt.get(attemptId);
        if (!row) return held('attempt_missing');
        if (findRelease.get(attemptId)) return held('candidate_released');
        if (findRejection.get(attemptId)) return held('candidate_rejected');
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
    recordFilePlan({ attemptId, hash, plannedFiles, nowMs }) {
      if (!validId(attemptId) || !validHash(hash) || !validTime(nowMs)) {
        throw new TypeError('Invalid file plan intent');
      }
      const plan = canonicalFilePlan(plannedFiles);
      return transact(() => {
        const row = findAttempt.get(attemptId);
        if (!row) return held('attempt_missing');
        if (findRelease.get(attemptId)) return held('candidate_released');
        if (findRejection.get(attemptId)) return held('candidate_rejected');
        if (nowMs < row.updated_ms) return held('time_before_last_transition');
        if (row.expected_hash !== hash.toLowerCase()) return held('torrent_conflict');
        const claimed = attemptEpisodes.all(attemptId).map((item) => item.episode_id);
        if (JSON.stringify(claimed) !== JSON.stringify(plan.targetIds)) {
          return held('file_plan_target_mismatch');
        }
        const stored = planRows.all(attemptId).map((item) => ({ name: item.file_name,
          size: item.file_size, episodeIds: JSON.parse(item.episode_key) }));
        if (stored.length) return JSON.stringify(stored) === JSON.stringify(plan.files)
          ? { state: 'planned' } : held('file_plan_conflict');
        if (row.status !== 'reserved') return held('file_plan_missing_after_dispatch');
        for (const file of plan.files) insertPlan.run(attemptId, file.name,
          file.size, JSON.stringify(file.episodeIds));
        touchAttempt.run(nowMs, attemptId);
        return { state: 'planned' };
      });
    },
    getFilePlan(attemptId) {
      if (!validId(attemptId)) throw new TypeError('Invalid attempt ID');
      if (!findAttempt.get(attemptId)) return null;
      const rows = planRows.all(attemptId);
      if (!rows.length) return null;
      try {
        const files = rows.map((item) => ({ name: item.file_name,
          size: item.file_size, episodeIds: JSON.parse(item.episode_key) }));
        const plan = canonicalFilePlan(files);
        return JSON.stringify(plan.targetIds) === JSON.stringify(
          attemptEpisodes.all(attemptId).map((item) => item.episode_id)) ? plan.files : null;
      } catch { return null; }
    },
    beginDispatch({ attemptId, nowMs }) {
      if (!validId(attemptId) || !validTime(nowMs)) throw new TypeError('Invalid dispatch intent');
      return transact(() => {
        const row = findAttempt.get(attemptId);
        if (!row) return held('attempt_missing');
        if (findRelease.get(attemptId)) return held('candidate_released');
        if (findRejection.get(attemptId)) return held('candidate_rejected');
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
        if (findRejection.get(attemptId)) return held('candidate_rejected');
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
        if (findRejection.get(attemptId)) return held('candidate_rejected');
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
      const rejection = row ? findRejection.get(attemptId) : null;
      return row ? { id: row.id, requestId: row.request_id, anidbId: row.anidb_id,
        episodeIds: attemptEpisodes.all(attemptId).map((target) => target.episode_id),
        ...(row.evidence_policy === 'first_time_permissive'
          ? { evidencePolicy: row.evidence_policy } : {}),
        status: findRelease.get(attemptId) ? 'released_pre_dispatch' :
          findRetirement.get(attemptId)?.reason === 'stalled_download'
            ? 'retired_stalled' :
            findRetirement.get(attemptId) ? 'retired_rejected' :
            rejection ? 'rejected_held' : row.status,
        expectedHash: row.expected_hash, torrentHash: row.torrent_hash,
        ...(rejection ? { rejectionReason: rejection.reason } : {}) } : null;
    },
    close() { db.close(); },
  };
}
