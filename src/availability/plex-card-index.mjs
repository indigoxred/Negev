import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const validId = (value) => Number.isSafeInteger(value) && value > 0;
const validPath = (value) => typeof value === 'string' && value.length <= 4096 &&
  path.posix.isAbsolute(value) && path.posix.normalize(value) === value &&
  !/[\0\r\n\\]/.test(value);
const validCandidateKey = (value, size) => typeof value === 'string' &&
  value.length <= 128 && /^(0|[1-9]\d{0,30}):([1-9]\d{0,30}):([1-9]\d{0,15})$/.test(value) &&
  (size === undefined || value.slice(value.lastIndexOf(':') + 1) === String(size));
const validGuid = (value) => value == null || (typeof value === 'string' &&
  value.length <= 512 && !/[\0\r\n]/.test(value));
const cardSignature = (kind, parts) => JSON.stringify([kind,
  [...parts].sort((a, b) => a.partId - b.partId).map((part) => [
    part.partId, part.size, part.plexPath, part.itemGuid ?? null,
    part.showGuid ?? null, [...(part.externalGuids ?? [])].sort()])]);

// Positive discovery only. Stored paths are private candidates, not playback
// proof. A target check must re-read each card and prove the physical Part.
export function openPlexCardIndex(dbPath) {
  if (typeof dbPath !== 'string' || !dbPath || dbPath === ':memory:') {
    throw new TypeError('Durable Plex index path required');
  }
  const db = new DatabaseSync(dbPath, { timeout: 5_000 });
  try {
    db.exec('PRAGMA journal_mode=WAL');
    db.exec(`CREATE TABLE IF NOT EXISTS plex_card_observations (
      library_id INTEGER NOT NULL CHECK(library_id>0),
      rating_key INTEGER NOT NULL CHECK(rating_key>0),
      kind TEXT NOT NULL CHECK(kind IN ('episode','movie')),
      observed_ms INTEGER NOT NULL CHECK(observed_ms>=0),
      identity_signature TEXT,
      PRIMARY KEY(library_id,rating_key)
    ) STRICT`);
    if (!db.prepare('PRAGMA table_info(plex_card_observations)').all()
      .some((column) => column.name === 'identity_signature')) {
      db.exec('ALTER TABLE plex_card_observations ADD COLUMN identity_signature TEXT');
    }
    db.exec(`CREATE TABLE IF NOT EXISTS plex_part_candidates (
      library_id INTEGER NOT NULL,
      rating_key INTEGER NOT NULL,
      part_id INTEGER NOT NULL CHECK(part_id>0),
      file_size INTEGER NOT NULL CHECK(file_size>0),
      plex_path TEXT NOT NULL,
      candidate_key TEXT,
      PRIMARY KEY(library_id,rating_key,part_id),
      FOREIGN KEY(library_id,rating_key)
        REFERENCES plex_card_observations(library_id,rating_key)
    ) STRICT`);
    if (!db.prepare('PRAGMA table_info(plex_part_candidates)').all()
      .some((column) => column.name === 'candidate_key')) {
      db.exec('ALTER TABLE plex_part_candidates ADD COLUMN candidate_key TEXT');
    }
    // Keep a removal timestamp after deleting a card. An older page read may
    // finish later, including after a service restart.
    db.exec(`CREATE TABLE IF NOT EXISTS plex_card_removals (
      library_id INTEGER NOT NULL CHECK(library_id>0),
      rating_key INTEGER NOT NULL CHECK(rating_key>0),
      observed_ms INTEGER NOT NULL CHECK(observed_ms>=0),
      PRIMARY KEY(library_id,rating_key)
    ) STRICT`);
    db.exec(`CREATE TABLE IF NOT EXISTS plex_card_change_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      library_id INTEGER NOT NULL CHECK(library_id>0),
      rating_key INTEGER NOT NULL CHECK(rating_key>0),
      observed_ms INTEGER NOT NULL CHECK(observed_ms>=0)
    ) STRICT`);
    db.exec(`CREATE INDEX IF NOT EXISTS plex_change_card
      ON plex_card_change_events(library_id,rating_key,id)`);
    db.exec('CREATE INDEX IF NOT EXISTS plex_candidate_size ON plex_part_candidates(file_size,library_id,rating_key)');
    db.exec('CREATE INDEX IF NOT EXISTS plex_candidate_identity ON plex_part_candidates(candidate_key,library_id,rating_key)');
    db.exec(`CREATE TABLE IF NOT EXISTS plex_card_cursors (
      library_id INTEGER NOT NULL CHECK(library_id>0),
      kind TEXT NOT NULL CHECK(kind IN ('episode','movie')),
      offset INTEGER NOT NULL CHECK(offset>=0),
      PRIMARY KEY(library_id,kind)
    ) STRICT`);
    db.exec(`CREATE TABLE IF NOT EXISTS plex_sweep_passes (
      library_id INTEGER NOT NULL CHECK(library_id>0),
      kind TEXT NOT NULL CHECK(kind IN ('episode','movie')),
      pass_num INTEGER NOT NULL CHECK(pass_num>0),
      total_size INTEGER NOT NULL CHECK(total_size>=0),
      started_ms INTEGER NOT NULL CHECK(started_ms>=0),
      status TEXT NOT NULL CHECK(status IN ('running','complete','invalid')),
      PRIMARY KEY(library_id,kind,pass_num)
    ) STRICT`);
    db.exec(`CREATE TABLE IF NOT EXISTS plex_sweep_keys (
      library_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      pass_num INTEGER NOT NULL,
      ordinal INTEGER NOT NULL CHECK(ordinal>=0),
      rating_key INTEGER NOT NULL CHECK(rating_key>0),
      PRIMARY KEY(library_id,kind,pass_num,ordinal),
      UNIQUE(library_id,kind,pass_num,rating_key),
      FOREIGN KEY(library_id,kind,pass_num)
        REFERENCES plex_sweep_passes(library_id,kind,pass_num) ON DELETE CASCADE
    ) STRICT`);
    db.exec(`CREATE TABLE IF NOT EXISTS plex_card_retries (
      library_id INTEGER NOT NULL CHECK(library_id>0),
      rating_key INTEGER NOT NULL CHECK(rating_key>0),
      kind TEXT NOT NULL CHECK(kind IN ('episode','movie')),
      attempts INTEGER NOT NULL CHECK(attempts>0),
      due_ms INTEGER NOT NULL CHECK(due_ms>=0),
      PRIMARY KEY(library_id,rating_key)
    ) STRICT`);
    db.exec('CREATE INDEX IF NOT EXISTS plex_retry_due ON plex_card_retries(library_id,kind,due_ms)');
    db.exec('PRAGMA foreign_keys=ON');
  } catch (error) { db.close(); throw error; }
  const previous = db.prepare(`SELECT observed_ms,identity_signature
    FROM plex_card_observations
    WHERE library_id=? AND rating_key=?`);
  const previousRemoval = db.prepare(`SELECT observed_ms FROM plex_card_removals
    WHERE library_id=? AND rating_key=?`);
  const saveChange = db.prepare(`INSERT INTO plex_card_change_events
    (library_id,rating_key,observed_ms) VALUES (?,?,?)`);
  let invalidateProof = null;
  const invalidateProvenCard = (observedMs, libraryId, ratingKey) => {
    if (!invalidateProof) {
      const columns = new Set(db.prepare(
        'PRAGMA table_info(direct_availability_targets)').all()
        .map((column) => column.name));
      if (columns.has('proof_library_id') && columns.has('proof_rating_key')) {
        invalidateProof = db.prepare(`UPDATE direct_availability_targets SET
          state='pending',due_ms=?,priority=1,version=version+1,
          verified_ms=NULL,proof_file_id=NULL,proof_library_id=NULL,
          proof_rating_key=NULL,proof_part_id=NULL
          WHERE proof_library_id=? AND proof_rating_key=?
            AND state='available'`);
      }
    }
    invalidateProof?.run(observedMs, libraryId, ratingKey);
  };
  const saveRemoval = db.prepare(`INSERT INTO plex_card_removals
    (library_id,rating_key,observed_ms) VALUES (?,?,?)
    ON CONFLICT(library_id,rating_key) DO UPDATE SET
    observed_ms=excluded.observed_ms`);
  const clearRemoval = db.prepare(`DELETE FROM plex_card_removals
    WHERE library_id=? AND rating_key=?`);
  const saveCard = db.prepare(`INSERT INTO plex_card_observations
    (library_id,rating_key,kind,observed_ms,identity_signature)
    VALUES (?,?,?,?,?)
    ON CONFLICT(library_id,rating_key) DO UPDATE SET
    kind=excluded.kind,observed_ms=excluded.observed_ms,
    identity_signature=excluded.identity_signature`);
  const clearParts = db.prepare(`DELETE FROM plex_part_candidates
    WHERE library_id=? AND rating_key=?`);
  const clearCard = db.prepare(`DELETE FROM plex_card_observations
    WHERE library_id=? AND rating_key=?`);
  const addPart = db.prepare(`INSERT INTO plex_part_candidates
    (library_id,rating_key,part_id,file_size,plex_path,candidate_key)
    VALUES (?,?,?,?,?,?)`);
  const oldRetry = db.prepare(`SELECT attempts FROM plex_card_retries
    WHERE library_id=? AND rating_key=?`);
  const saveRetry = db.prepare(`INSERT INTO plex_card_retries
    (library_id,rating_key,kind,attempts,due_ms) VALUES (?,?,?,?,?)
    ON CONFLICT(library_id,rating_key) DO UPDATE SET
    kind=excluded.kind,attempts=excluded.attempts,due_ms=excluded.due_ms`);
  const clearRetry = db.prepare(`DELETE FROM plex_card_retries
    WHERE library_id=? AND rating_key=?`);
  const dueRetry = db.prepare(`SELECT rating_key AS ratingKey FROM plex_card_retries
    WHERE library_id=? AND kind=? AND due_ms<=?
    ORDER BY due_ms,rating_key LIMIT 1`);
  const cursor = db.prepare(`SELECT offset FROM plex_card_cursors
    WHERE library_id=? AND kind=?`);
  const saveCursor = db.prepare(`INSERT INTO plex_card_cursors
    (library_id,kind,offset) VALUES (?,?,?) ON CONFLICT(library_id,kind)
    DO UPDATE SET offset=excluded.offset`);
  const latestPass = db.prepare(`SELECT pass_num AS passNum,
    total_size AS totalSize, started_ms AS startedMs, status
    FROM plex_sweep_passes WHERE library_id=? AND kind=?
    ORDER BY pass_num DESC LIMIT 1`);
  const priorPass = db.prepare(`SELECT pass_num AS passNum,
    total_size AS totalSize, started_ms AS startedMs, status
    FROM plex_sweep_passes WHERE library_id=? AND kind=? AND pass_num=?`);
  const startPass = db.prepare(`INSERT INTO plex_sweep_passes
    (library_id,kind,pass_num,total_size,started_ms,status)
    VALUES (?,?,?,?,?,'running')`);
  const markPass = db.prepare(`UPDATE plex_sweep_passes SET status=?
    WHERE library_id=? AND kind=? AND pass_num=?`);
  const addSweepKey = db.prepare(`INSERT INTO plex_sweep_keys
    (library_id,kind,pass_num,ordinal,rating_key) VALUES (?,?,?,?,?)`);
  const sweepCount = db.prepare(`SELECT COUNT(*) AS count FROM plex_sweep_keys
    WHERE library_id=? AND kind=? AND pass_num=?`);
  const sweepMismatch = db.prepare(`SELECT COUNT(*) AS count
    FROM plex_sweep_keys current
    LEFT JOIN plex_sweep_keys previous
      ON previous.library_id=current.library_id AND previous.kind=current.kind
      AND previous.pass_num=? AND previous.ordinal=current.ordinal
    WHERE current.library_id=? AND current.kind=? AND current.pass_num=?
      AND (previous.rating_key IS NULL OR previous.rating_key<>current.rating_key)`);
  const unseenCards = db.prepare(`SELECT c.rating_key AS ratingKey
    FROM plex_card_observations c WHERE c.library_id=? AND c.kind=?
      AND c.observed_ms<? AND NOT EXISTS (
        SELECT 1 FROM plex_sweep_keys k WHERE k.library_id=c.library_id
          AND k.kind=c.kind AND k.pass_num=? AND k.rating_key=c.rating_key)`);
  const prunePasses = db.prepare(`DELETE FROM plex_sweep_passes
    WHERE library_id=? AND kind=? AND pass_num<?`);
  const candidateQueries = new Map();
  const identityQueries = new Map();
  const sizeCandidates = (libraryCount) => {
    if (!candidateQueries.has(libraryCount)) candidateQueries.set(libraryCount,
      db.prepare(`SELECT DISTINCT p.library_id AS libraryId,
        p.rating_key AS ratingKey FROM plex_part_candidates p
        JOIN plex_card_observations c ON c.library_id=p.library_id
          AND c.rating_key=p.rating_key
        WHERE p.file_size=? AND c.kind=? AND p.library_id IN
          (${Array(libraryCount).fill('?').join(',')})
        ORDER BY p.library_id,p.rating_key LIMIT 11`));
    return candidateQueries.get(libraryCount);
  };
  const identityCandidates = (libraryCount) => {
    if (!identityQueries.has(libraryCount)) identityQueries.set(libraryCount,
      db.prepare(`SELECT DISTINCT p.library_id AS libraryId,
        p.rating_key AS ratingKey FROM plex_part_candidates p
        JOIN plex_card_observations c ON c.library_id=p.library_id
          AND c.rating_key=p.rating_key
        WHERE p.candidate_key=? AND c.kind=? AND p.library_id IN
          (${Array(libraryCount).fill('?').join(',')})
        ORDER BY p.library_id,p.rating_key LIMIT 11`));
    return identityQueries.get(libraryCount);
  };
  return {
    forgetCard({ libraryId, ratingKey, observedMs }) {
      if (!validId(libraryId) || !validId(ratingKey) ||
          !Number.isSafeInteger(observedMs) || observedMs < 0) {
        throw new TypeError('Invalid Plex card removal observation');
      }
      let begun = false;
      try {
        db.exec('BEGIN IMMEDIATE'); begun = true;
        const old = previous.get(libraryId, ratingKey);
        const removed = previousRemoval.get(libraryId, ratingKey);
        if ((old && old.observed_ms >= observedMs) ||
            (removed && removed.observed_ms >= observedMs)) {
          db.exec('ROLLBACK'); begun = false;
          return { state: 'stale_card' };
        }
        if (old) {
          clearParts.run(libraryId, ratingKey);
          clearCard.run(libraryId, ratingKey);
        }
        saveRemoval.run(libraryId, ratingKey, observedMs);
        saveChange.run(libraryId, ratingKey, observedMs);
        invalidateProvenCard(observedMs, libraryId, ratingKey);
        clearRetry.run(libraryId, ratingKey);
        db.exec('COMMIT'); begun = false;
        return { state: old ? 'card_forgotten' : 'card_absent' };
      } catch (error) {
        if (begun) db.exec('ROLLBACK');
        throw error;
      }
    },
    recordCard({ libraryId, ratingKey, kind, parts, observedMs }) {
      if (!validId(libraryId) || !validId(ratingKey) ||
          !['episode', 'movie'].includes(kind) ||
          !Number.isSafeInteger(observedMs) || observedMs < 0 ||
          !Array.isArray(parts) || parts.length < 1 || parts.length > 400 ||
          parts.some((part) => !validId(part?.partId) ||
            part.libraryId !== libraryId || !validId(part.size) ||
            !validPath(part.plexPath) ||
            !validGuid(part.itemGuid) || !validGuid(part.showGuid) ||
            (part.externalGuids != null && (!Array.isArray(part.externalGuids) ||
              part.externalGuids.length > 50 ||
              part.externalGuids.some((guid) => !validGuid(guid)))) ||
            (part.candidateKey != null &&
              !validCandidateKey(part.candidateKey, part.size))) ||
          new Set(parts.map((part) => part.partId)).size !== parts.length) {
        throw new TypeError('Invalid Plex card observation');
      }
      let begun = false;
      try {
        db.exec('BEGIN IMMEDIATE'); begun = true;
        const old = previous.get(libraryId, ratingKey);
        const removed = previousRemoval.get(libraryId, ratingKey);
        if ((old && old.observed_ms >= observedMs) ||
            (removed && removed.observed_ms >= observedMs)) {
          db.exec('ROLLBACK'); begun = false;
          return { state: 'stale_card' };
        }
        const signature = cardSignature(kind, parts);
        const changed = !old || old.identity_signature !== signature;
        saveCard.run(libraryId, ratingKey, kind, observedMs, signature);
        if (changed) {
          saveChange.run(libraryId, ratingKey, observedMs);
          invalidateProvenCard(observedMs, libraryId, ratingKey);
        }
        if (removed) clearRemoval.run(libraryId, ratingKey);
        clearParts.run(libraryId, ratingKey);
        for (const part of parts) addPart.run(libraryId, ratingKey,
          part.partId, part.size, part.plexPath, part.candidateKey ?? null);
        clearRetry.run(libraryId, ratingKey);
        db.exec('COMMIT'); begun = false;
        return { state: 'recorded_card' };
      } catch (error) {
        if (begun) db.exec('ROLLBACK');
        throw error;
      }
    },
    deferCard({ libraryId, ratingKey, kind, nowMs }) {
      if (!validId(libraryId) || !validId(ratingKey) ||
          !['episode', 'movie'].includes(kind) ||
          !Number.isSafeInteger(nowMs) || nowMs < 0) {
        throw new TypeError('Invalid Plex card retry');
      }
      const attempts = Math.min((oldRetry.get(libraryId, ratingKey)?.attempts ?? 0) + 1, 7);
      const dueMs = nowMs + Math.min(60_000 * 2 ** (attempts - 1), 3_600_000);
      if (!Number.isSafeInteger(dueMs)) throw new TypeError('Invalid retry clock');
      saveRetry.run(libraryId, ratingKey, kind, attempts, dueMs);
      return { state: 'retry_deferred' };
    },
    nextRetry({ libraryId, kind, nowMs }) {
      if (!validId(libraryId) || !['episode', 'movie'].includes(kind) ||
          !Number.isSafeInteger(nowMs) || nowMs < 0) {
        throw new TypeError('Invalid Plex retry query');
      }
      const row = dueRetry.get(libraryId, kind, nowMs);
      return row ? { ratingKey: row.ratingKey } : null;
    },
    clearRetry({ libraryId, ratingKey }) {
      if (!validId(libraryId) || !validId(ratingKey)) {
        throw new TypeError('Invalid Plex retry clear');
      }
      clearRetry.run(libraryId, ratingKey);
    },
    lookupCards({ sizes, libraryIds, kind }) {
      if (!Array.isArray(sizes) || sizes.length < 1 || sizes.length > 50 ||
          sizes.some((size) => !validId(size)) ||
          !Array.isArray(libraryIds) || libraryIds.length < 1 ||
          libraryIds.length > 20 || libraryIds.some((id) => !validId(id)) ||
          !['episode', 'movie'].includes(kind)) {
        throw new TypeError('Invalid Plex candidate query');
      }
      const cards = new Map();
      for (const size of new Set(sizes)) {
        for (const row of sizeCandidates(libraryIds.length).all(size, kind, ...libraryIds)) {
          cards.set(`${row.libraryId}:${row.ratingKey}`,
            { libraryId: row.libraryId, ratingKey: row.ratingKey });
          if (cards.size > 10) {
            return { state: 'held', reason: 'candidate_budget_exceeded' };
          }
        }
      }
      return { state: 'candidates', cards: [...cards.values()].sort((a, b) =>
        a.libraryId - b.libraryId || a.ratingKey - b.ratingKey) };
    },
    lookupCardsByCandidateKey({ keys, libraryIds, kind }) {
      if (!Array.isArray(keys) || keys.length < 1 || keys.length > 50 ||
          keys.some((key) => !validCandidateKey(key)) ||
          !Array.isArray(libraryIds) || libraryIds.length < 1 ||
          libraryIds.length > 20 || libraryIds.some((id) => !validId(id)) ||
          !['episode', 'movie'].includes(kind)) {
        throw new TypeError('Invalid Plex identity candidate query');
      }
      const cards = new Map();
      for (const key of new Set(keys)) {
        for (const row of identityCandidates(libraryIds.length).all(key, kind,
          ...libraryIds)) {
          cards.set(`${row.libraryId}:${row.ratingKey}`,
            { libraryId: row.libraryId, ratingKey: row.ratingKey });
          if (cards.size > 10) {
            return { state: 'held', reason: 'candidate_budget_exceeded' };
          }
        }
      }
      return { state: 'candidates', cards: [...cards.values()].sort((a, b) =>
        a.libraryId - b.libraryId || a.ratingKey - b.ratingKey) };
    },
    getCursor({ libraryId, kind }) {
      if (!validId(libraryId) || !['episode', 'movie'].includes(kind)) {
        throw new TypeError('Invalid Plex cursor');
      }
      return cursor.get(libraryId, kind)?.offset ?? 0;
    },
    advanceCursor({ libraryId, kind, expectedOffset, nextOffset,
      pageKeys, totalSize, observedMs }) {
      if (!validId(libraryId) || !['episode', 'movie'].includes(kind) ||
          !Number.isSafeInteger(expectedOffset) || expectedOffset < 0 ||
          !Number.isSafeInteger(nextOffset) || nextOffset < 0 ||
          (pageKeys !== undefined && (!Array.isArray(pageKeys) ||
            pageKeys.length > 5 || pageKeys.some((key) => !validId(key)) ||
            new Set(pageKeys).size !== pageKeys.length ||
            !Number.isSafeInteger(totalSize) || totalSize < expectedOffset + pageKeys.length ||
            !Number.isSafeInteger(observedMs) || observedMs < 0))) {
        throw new TypeError('Invalid Plex cursor advance');
      }
      let begun = false;
      try {
        db.exec('BEGIN IMMEDIATE'); begun = true;
        const old = cursor.get(libraryId, kind)?.offset ?? 0;
        if (old !== expectedOffset) {
          db.exec('ROLLBACK'); begun = false;
          return { state: 'held', reason: 'stale_cursor' };
        }
        if (pageKeys !== undefined) {
          let pass = latestPass.get(libraryId, kind);
          if (expectedOffset === 0) {
            const passNum = (pass?.passNum ?? 0) + 1;
            startPass.run(libraryId, kind, passNum, totalSize, observedMs);
            pass = { passNum, totalSize, startedMs: observedMs, status: 'running' };
          }
          if (pass?.status === 'running') {
            if (pass.totalSize !== totalSize) {
              markPass.run('invalid', libraryId, kind, pass.passNum);
            } else {
              try {
                for (let i = 0; i < pageKeys.length; i++) {
                  addSweepKey.run(libraryId, kind, pass.passNum,
                    expectedOffset + i, pageKeys[i]);
                }
              } catch {
                markPass.run('invalid', libraryId, kind, pass.passNum);
              }
              if (nextOffset === 0 &&
                  sweepCount.get(libraryId, kind, pass.passNum).count === totalSize &&
                  latestPass.get(libraryId, kind)?.status === 'running') {
                markPass.run('complete', libraryId, kind, pass.passNum);
                const prior = priorPass.get(libraryId, kind, pass.passNum - 1);
                if (prior?.status === 'complete' && prior.totalSize === totalSize &&
                    prior.startedMs < pass.startedMs && pass.startedMs <= observedMs &&
                    sweepCount.get(libraryId, kind, prior.passNum).count === totalSize &&
                    sweepMismatch.get(prior.passNum, libraryId, kind,
                      pass.passNum).count === 0) {
                  for (const row of unseenCards.all(libraryId, kind,
                    prior.startedMs, pass.passNum)) {
                    clearParts.run(libraryId, row.ratingKey);
                    clearCard.run(libraryId, row.ratingKey);
                    saveRemoval.run(libraryId, row.ratingKey, observedMs);
                    clearRetry.run(libraryId, row.ratingKey);
                  }
                }
                prunePasses.run(libraryId, kind, pass.passNum - 1);
              }
            }
          }
        }
        saveCursor.run(libraryId, kind, nextOffset);
        db.exec('COMMIT'); begun = false;
        return { state: 'cursor_advanced', offset: nextOffset };
      } catch (error) {
        if (begun) db.exec('ROLLBACK');
        throw error;
      }
    },
    close() { db.close(); },
  };
}
