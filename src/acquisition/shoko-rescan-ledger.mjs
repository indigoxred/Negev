import { DatabaseSync } from 'node:sqlite';

const validId = (value) => Number.isSafeInteger(value) && value > 0;
const validTime = (value) => Number.isSafeInteger(value) && value >= 0;
const held = (reason) => ({ state: 'held', reason });

// Enrol only attempts created after this policy is installed. Historical
// imports remain untouched; their media and request records are not replayed.
export function openShokoRescanLedger(dbPath) {
  if (typeof dbPath !== 'string' || !dbPath || dbPath === ':memory:') {
    throw new TypeError('Durable Shoko rescan path required');
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
    db.exec(`CREATE TABLE IF NOT EXISTS shoko_rescan_policy (
      id INTEGER PRIMARY KEY CHECK(id=1),
      minimum_attempt_id INTEGER NOT NULL CHECK(minimum_attempt_id>0)
    ) STRICT`);
    db.exec(`CREATE TABLE IF NOT EXISTS shoko_rescan_attempts (
      attempt_id INTEGER PRIMARY KEY REFERENCES acquisition_attempts(id),
      status TEXT NOT NULL CHECK(status IN ('pending','done','review')),
      next_due_ms INTEGER NOT NULL CHECK(next_due_ms>=0),
      updated_ms INTEGER NOT NULL CHECK(updated_ms>=0)
    ) STRICT`);
    db.exec(`CREATE TABLE IF NOT EXISTS shoko_rescan_files (
      attempt_id INTEGER NOT NULL REFERENCES acquisition_attempts(id),
      file_name TEXT NOT NULL,
      file_id INTEGER NOT NULL CHECK(file_id>0),
      status TEXT NOT NULL CHECK(status IN
        ('observed','dispatched','linked','unresolved')),
      first_seen_ms INTEGER NOT NULL CHECK(first_seen_ms>=0),
      updated_ms INTEGER NOT NULL CHECK(updated_ms>=first_seen_ms),
      PRIMARY KEY(attempt_id,file_name)
    ) STRICT`);
    db.prepare(`INSERT OR IGNORE INTO shoko_rescan_policy(id,minimum_attempt_id)
      SELECT 1,COALESCE(MAX(id),0)+1 FROM acquisition_attempts`).run();
  } catch (error) { db.close(); throw error; }
  const due = db.prepare(`SELECT a.id AS attemptId,r.id AS requestId,
    r.anidb_id AS anidbId,p.manifest_json AS manifestJson,
    p.updated_ms AS publishedMs
    FROM acquisition_attempts a
    JOIN shoko_rescan_policy policy ON policy.id=1 AND
      a.id>=policy.minimum_attempt_id
    JOIN requests r ON r.id=a.request_id AND r.status='held' AND
      r.cancelled_ms IS NULL
    JOIN pure_move_intents p ON p.attempt_id=a.id AND
      p.status='published_observed'
    JOIN acquisition_target_claims c ON c.attempt_id=a.id AND c.active=1
    LEFT JOIN shoko_rescan_attempts progress ON progress.attempt_id=a.id
    WHERE p.updated_ms<=? AND (progress.attempt_id IS NULL OR
      (progress.status='pending' AND progress.next_due_ms<=?))
    GROUP BY a.id ORDER BY a.id ASC LIMIT ?`);
  const eligible = db.prepare(`SELECT p.manifest_json AS manifestJson
    FROM acquisition_attempts a
    JOIN shoko_rescan_policy policy ON policy.id=1 AND
      a.id>=policy.minimum_attempt_id
    JOIN pure_move_intents p ON p.attempt_id=a.id AND
      p.status='published_observed' WHERE a.id=?`);
  const fileRow = db.prepare(`SELECT file_id AS fileId,status,
    first_seen_ms AS firstSeenMs,updated_ms AS updatedMs
    FROM shoko_rescan_files WHERE attempt_id=? AND file_name=?`);
  const floor = db.prepare(`SELECT minimum_attempt_id AS minimumAttemptId
    FROM shoko_rescan_policy WHERE id=1`).get().minimumAttemptId;
  const attemptStatus = db.prepare(`SELECT status FROM shoko_rescan_attempts
    WHERE attempt_id=?`);
  const reviewRows = db.prepare(`SELECT a.attempt_id AS attemptId,
    r.id AS requestId,r.anidb_id AS anidbId,
    'shoko_rescan_unresolved' AS reason,a.updated_ms AS observedMs
    FROM shoko_rescan_attempts a
    JOIN acquisition_attempts attempts ON attempts.id=a.attempt_id
    JOIN requests r ON r.id=attempts.request_id
    WHERE a.status='review' AND a.attempt_id>?
    ORDER BY a.attempt_id LIMIT ?`);
  const insertFile = db.prepare(`INSERT INTO shoko_rescan_files
    (attempt_id,file_name,file_id,status,first_seen_ms,updated_ms)
    VALUES (?,?,?,'observed',?,?)`);
  const updateFile = db.prepare(`UPDATE shoko_rescan_files
    SET status=?,updated_ms=? WHERE attempt_id=? AND file_name=? AND
      file_id=? AND status=?`);
  const upsertAttempt = db.prepare(`INSERT INTO shoko_rescan_attempts
    (attempt_id,status,next_due_ms,updated_ms) VALUES (?,'pending',?,?)
    ON CONFLICT(attempt_id) DO UPDATE SET next_due_ms=excluded.next_due_ms,
      updated_ms=excluded.updated_ms WHERE status='pending'`);
  const endAttempt = db.prepare(`INSERT INTO shoko_rescan_attempts
    (attempt_id,status,next_due_ms,updated_ms) VALUES (?,?,?,?)
    ON CONFLICT(attempt_id) DO UPDATE SET status=excluded.status,
      next_due_ms=excluded.next_due_ms,updated_ms=excluded.updated_ms
      WHERE status='pending'`);
  const transact = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const hasFile = (attemptId, fileName) => {
    const row = eligible.get(attemptId);
    if (!row) return false;
    try {
      return JSON.parse(row.manifestJson)?.files?.some((file) =>
        file.name === fileName && Array.isArray(file.episodeIds)) === true;
    } catch { return false; }
  };
  return {
    isEnrolled(attemptId) {
      if (!validId(attemptId)) throw new TypeError('Invalid rescan attempt');
      return attemptId >= floor;
    },
    getAttemptStatus(attemptId) {
      if (!validId(attemptId)) throw new TypeError('Invalid rescan attempt');
      return attemptStatus.get(attemptId)?.status ?? null;
    },
    listDue({ nowMs, limit = 20 } = {}) {
      if (!validTime(nowMs) || !Number.isSafeInteger(limit) ||
          limit < 1 || limit > 50) throw new TypeError('Invalid rescan page');
      return due.all(nowMs >= 300_000 ? nowMs - 300_000 : -1,
        nowMs, limit).map((row) => {
        try {
          const manifest = JSON.parse(row.manifestJson);
          const videos = manifest?.files?.filter((file) =>
            Array.isArray(file.episodeIds));
          return videos?.length > 0 && videos.length <= 50 &&
            typeof manifest.torrentHash === 'string' &&
            /^[a-f0-9]{40}$/i.test(manifest.torrentHash) &&
            videos.every((file) => validId(file.size) &&
              typeof file.name === 'string' && file.name &&
              file.episodeIds.length > 0 &&
              file.episodeIds.every(validId))
            ? { ...row, manifest } : { ...row, manifest: null };
        } catch { return { ...row, manifest: null }; }
      });
    },
    listReviewNeeded({ afterAttemptId = 0, limit = 20 } = {}) {
      if (!validTime(afterAttemptId) || !Number.isSafeInteger(limit) ||
          limit < 1 || limit > 21) throw new TypeError('Invalid rescan review');
      return reviewRows.all(afterAttemptId, limit);
    },
    getFile(attemptId, fileName) {
      if (!validId(attemptId) || typeof fileName !== 'string') {
        throw new TypeError('Invalid rescan file');
      }
      return fileRow.get(attemptId, fileName) ?? null;
    },
    observeFile({ attemptId, fileName, fileId, nowMs }) {
      if (!validId(attemptId) || !validId(fileId) || !validTime(nowMs) ||
          typeof fileName !== 'string') throw new TypeError('Invalid file witness');
      return transact(() => {
        if (!hasFile(attemptId, fileName)) return held('rescan_ineligible');
        const prior = fileRow.get(attemptId, fileName);
        if (prior) return prior.fileId === fileId
          ? { state: prior.status, firstSeenMs: prior.firstSeenMs }
          : held('shoko_file_changed');
        insertFile.run(attemptId, fileName, fileId, nowMs, nowMs);
        upsertAttempt.run(attemptId, nowMs + 60_000, nowMs);
        return { state: 'observed', firstSeenMs: nowMs };
      });
    },
    beginDispatch({ attemptId, fileName, fileId, nowMs }) {
      if (!validId(attemptId) || !validId(fileId) || !validTime(nowMs) ||
          typeof fileName !== 'string') throw new TypeError('Invalid rescan intent');
      return transact(() => {
        const prior = fileRow.get(attemptId, fileName);
        if (!prior || prior.fileId !== fileId ||
            prior.status !== 'observed' ||
            nowMs < prior.firstSeenMs + 60_000) {
          return held('rescan_not_confirmed');
        }
        if (updateFile.run('dispatched', nowMs, attemptId, fileName,
          fileId, 'observed').changes !== 1) return held('rescan_state_changed');
        upsertAttempt.run(attemptId, nowMs + 60_000, nowMs);
        return { state: 'dispatched' };
      });
    },
    markLinked({ attemptId, fileName, fileId, nowMs }) {
      if (!validId(attemptId) || !validId(fileId) || !validTime(nowMs) ||
          typeof fileName !== 'string') throw new TypeError('Invalid linked file');
      return transact(() => {
        const prior = fileRow.get(attemptId, fileName);
        if (!prior || prior.fileId !== fileId) return held('rescan_file_changed');
        if (prior.status !== 'linked') updateFile.run('linked', nowMs,
          attemptId, fileName, fileId, prior.status);
        upsertAttempt.run(attemptId, nowMs, nowMs);
        return { state: 'linked' };
      });
    },
    markUnresolved({ attemptId, fileName, fileId, nowMs }) {
      if (!validId(attemptId) || !validId(fileId) || !validTime(nowMs) ||
          typeof fileName !== 'string') throw new TypeError('Invalid unresolved file');
      return transact(() => {
        const prior = fileRow.get(attemptId, fileName);
        if (!prior || prior.fileId !== fileId ||
            prior.status !== 'dispatched') return held('rescan_state_changed');
        updateFile.run('unresolved', nowMs, attemptId, fileName,
          fileId, 'dispatched');
        upsertAttempt.run(attemptId, nowMs, nowMs);
        return { state: 'unresolved' };
      });
    },
    delayAttempt({ attemptId, nextDueMs, nowMs }) {
      if (!validId(attemptId) || !validTime(nextDueMs) || !validTime(nowMs) ||
          !eligible.get(attemptId)) {
        throw new TypeError('Invalid rescan delay');
      }
      upsertAttempt.run(attemptId, nextDueMs, nowMs);
    },
    endAttempt({ attemptId, review, nowMs }) {
      if (!validId(attemptId) || typeof review !== 'boolean' ||
          !validTime(nowMs) || !eligible.get(attemptId)) {
        throw new TypeError('Invalid rescan completion');
      }
      endAttempt.run(attemptId, review ? 'review' : 'done', nowMs, nowMs);
    },
    close() { db.close(); },
  };
}
