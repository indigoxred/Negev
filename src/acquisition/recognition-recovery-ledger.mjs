import { DatabaseSync } from 'node:sqlite';

const held = (reason) => ({ state: 'held', reason });
const validId = (value) => Number.isSafeInteger(value) && value > 0;
const validTime = (value) => Number.isSafeInteger(value) && value >= 0;

// The old episode claim remains active until a caller has preserved the exact
// published tree. This journal makes a restart between intent and rename safe.
export function openRecognitionRecoveryLedger(dbPath) {
  if (typeof dbPath !== 'string' || !dbPath || dbPath === ':memory:') {
    throw new TypeError('Durable recognition recovery path required');
  }
  const db = new DatabaseSync(dbPath, { timeout: 5_000 });
  try {
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA foreign_keys=ON');
    for (const name of ['requests', 'acquisition_attempts',
      'acquisition_target_claims', 'pure_move_intents']) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
        .get(name)) throw new TypeError('Acquisition journals must open first');
    }
    db.exec(`CREATE TABLE IF NOT EXISTS recognition_recoveries (
      attempt_id INTEGER PRIMARY KEY REFERENCES acquisition_attempts(id),
      file_id INTEGER NOT NULL CHECK(file_id>0),
      status TEXT NOT NULL CHECK(status IN
        ('observed','preserve_unknown','preserved','released')),
      first_seen_ms INTEGER NOT NULL CHECK(first_seen_ms>=0),
      updated_ms INTEGER NOT NULL CHECK(updated_ms>=first_seen_ms)
    ) STRICT`);
  } catch (error) { db.close(); throw error; }
  const row = db.prepare(`SELECT attempt_id AS attemptId,file_id AS fileId,
    status,first_seen_ms AS firstSeenMs,updated_ms AS updatedMs
    FROM recognition_recoveries WHERE attempt_id=?`);
  const pending = db.prepare(`SELECT a.id AS attemptId FROM acquisition_attempts a
    JOIN requests r ON r.id=a.request_id AND r.status='held' AND
      r.cancelled_ms IS NULL
    JOIN pure_move_intents p ON p.attempt_id=a.id AND
      p.status='published_observed'
    JOIN acquisition_target_claims c ON c.attempt_id=a.id AND c.active=1
    LEFT JOIN pure_move_content_observations content ON content.attempt_id=a.id
    LEFT JOIN recognition_recoveries recovery ON recovery.attempt_id=a.id
    WHERE a.request_id=? AND content.attempt_id IS NULL AND
      (recovery.attempt_id IS NULL OR recovery.status<>'released')
    GROUP BY a.id ORDER BY a.id LIMIT 1`);
  const pendingPage = db.prepare(`SELECT a.id AS attemptId FROM acquisition_attempts a
    JOIN requests r ON r.id=a.request_id AND r.status='held' AND
      r.cancelled_ms IS NULL
    JOIN pure_move_intents p ON p.attempt_id=a.id AND
      p.status='published_observed'
    JOIN acquisition_target_claims c ON c.attempt_id=a.id AND c.active=1
    LEFT JOIN pure_move_content_observations content ON content.attempt_id=a.id
    LEFT JOIN recognition_recoveries recovery ON recovery.attempt_id=a.id
    WHERE a.id>? AND content.attempt_id IS NULL AND
      (recovery.attempt_id IS NULL OR recovery.status<>'released')
    GROUP BY a.id ORDER BY a.id LIMIT ?`);
  const releasedTargets = db.prepare(`SELECT DISTINCT c.episode_id AS episodeId
    FROM recognition_recoveries recovery
    JOIN acquisition_attempts a ON a.id=recovery.attempt_id
    JOIN acquisition_target_claims c ON c.attempt_id=a.id
    WHERE a.request_id=? AND recovery.status='released'
    ORDER BY c.episode_id`);
  const eligible = db.prepare(`SELECT a.request_id AS requestId,
    p.manifest_json AS manifestJson,p.updated_ms AS publishedMs
    FROM acquisition_attempts a
    JOIN pure_move_intents p ON p.attempt_id=a.id AND
      p.status='published_observed'
    JOIN requests r ON r.id=a.request_id AND r.status='held' AND
      r.cancelled_ms IS NULL
    LEFT JOIN pure_move_content_observations content ON content.attempt_id=a.id
    WHERE a.id=? AND content.attempt_id IS NULL`);
  const active = db.prepare(`SELECT episode_id AS episodeId FROM acquisition_target_claims
    WHERE attempt_id=? AND active=1 ORDER BY episode_id`);
  const priorRecovery = db.prepare(`SELECT 1 FROM recognition_recoveries prior
    JOIN acquisition_target_claims old ON old.attempt_id=prior.attempt_id
    JOIN acquisition_target_claims current ON
      current.anidb_id=old.anidb_id AND current.episode_id=old.episode_id
    WHERE current.attempt_id=? AND prior.status='released' LIMIT 1`);
  const insert = db.prepare(`INSERT INTO recognition_recoveries
    (attempt_id,file_id,status,first_seen_ms,updated_ms)
    VALUES (?,?,'observed',?,?)`);
  const update = db.prepare(`UPDATE recognition_recoveries
    SET status=?,updated_ms=? WHERE attempt_id=? AND status=?`);
  const deactivate = db.prepare(`UPDATE acquisition_target_claims SET active=0
    WHERE attempt_id=? AND active=1`);
  const transact = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const check = (attemptId) => {
    const found = eligible.get(attemptId);
    if (!found || priorRecovery.get(attemptId)) return null;
    let manifest;
    try { manifest = JSON.parse(found.manifestJson); }
    catch { return null; }
    const videos = manifest?.files?.filter((file) =>
      Array.isArray(file.episodeIds));
    if (videos?.length !== 1 || !Array.isArray(videos[0].episodeIds) ||
        videos[0].episodeIds.length < 1 ||
        JSON.stringify([...videos[0].episodeIds].sort((a, b) => a - b)) !==
          JSON.stringify(active.all(attemptId).map((item) => item.episodeId))) {
      return null;
    }
    return { ...found, manifest, video: videos[0] };
  };
  return {
    getPendingForRequest(requestId) {
      if (!validId(requestId)) throw new TypeError('Invalid request');
      const found = pending.get(requestId);
      return found && check(found.attemptId) ? found : null;
    },
    listPending({ afterAttemptId = 0, limit = 20 } = {}) {
      if (!Number.isSafeInteger(afterAttemptId) || afterAttemptId < 0 ||
          !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
        throw new TypeError('Invalid recovery page');
      }
      return pendingPage.all(afterAttemptId, limit)
        .filter((item) => check(item.attemptId));
    },
    getReleasedTargets(requestId) {
      if (!validId(requestId)) throw new TypeError('Invalid request');
      return releasedTargets.all(requestId).map((item) => item.episodeId);
    },
    get(attemptId) {
      if (!validId(attemptId)) throw new TypeError('Invalid attempt');
      return row.get(attemptId) ?? null;
    },
    getEligible(attemptId) {
      if (!validId(attemptId)) throw new TypeError('Invalid attempt');
      return check(attemptId);
    },
    recordFirstSeen({ attemptId, fileId, nowMs }) {
      if (!validId(attemptId) || !validId(fileId) || !validTime(nowMs)) {
        throw new TypeError('Invalid recognition witness');
      }
      return transact(() => {
        const found = check(attemptId);
        if (!found || nowMs < found.publishedMs) return held('recovery_ineligible');
        const previous = row.get(attemptId);
        if (previous) return previous.fileId === fileId
          ? { state: previous.status, firstSeenMs: previous.firstSeenMs }
          : held('recognition_file_changed');
        insert.run(attemptId, fileId, nowMs, nowMs);
        return { state: 'observed', firstSeenMs: nowMs };
      });
    },
    beginPreserve({ attemptId, fileId, nowMs }) {
      if (!validId(attemptId) || !validId(fileId) || !validTime(nowMs)) {
        throw new TypeError('Invalid preservation intent');
      }
      return transact(() => {
        if (!check(attemptId)) return held('recovery_ineligible');
        const previous = row.get(attemptId);
        if (previous?.fileId !== fileId ||
            nowMs < previous.firstSeenMs + 60_000) {
          return held('recognition_not_confirmed');
        }
        if (previous.status === 'preserve_unknown') {
          return { state: 'preserve_unknown', sendNow: false };
        }
        if (previous.status !== 'observed') return held('preservation_state_changed');
        return update.run('preserve_unknown', nowMs, attemptId,
          'observed').changes === 1
          ? { state: 'preserve_unknown', sendNow: true }
          : held('preservation_state_changed');
      });
    },
    markPreserved({ attemptId, nowMs }) {
      if (!validId(attemptId) || !validTime(nowMs)) {
        throw new TypeError('Invalid preserved state');
      }
      return transact(() => {
        const previous = row.get(attemptId);
        if (previous?.status === 'preserved' || previous?.status === 'released') {
          return { state: 'preserved' };
        }
        if (!check(attemptId) || previous?.status !== 'preserve_unknown' ||
            nowMs < previous.updatedMs) return held('preservation_state_changed');
        return update.run('preserved', nowMs, attemptId,
          'preserve_unknown').changes === 1
          ? { state: 'preserved' } : held('preservation_state_changed');
      });
    },
    releaseForAlternate({ attemptId, nowMs }) {
      if (!validId(attemptId) || !validTime(nowMs)) {
        throw new TypeError('Invalid alternate release');
      }
      return transact(() => {
        const previous = row.get(attemptId);
        if (previous?.status === 'released') return { state: 'released' };
        if (!check(attemptId) || previous?.status !== 'preserved' ||
            nowMs < previous.updatedMs) return held('preservation_not_proven');
        if (update.run('released', nowMs, attemptId,
          'preserved').changes !== 1) return held('recovery_state_changed');
        deactivate.run(attemptId);
        return { state: 'released' };
      });
    },
    close() { db.close(); },
  };
}
