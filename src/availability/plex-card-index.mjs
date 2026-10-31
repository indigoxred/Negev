import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const validId = (value) => Number.isSafeInteger(value) && value > 0;
const validPath = (value) => typeof value === 'string' && value.length <= 4096 &&
  path.posix.isAbsolute(value) && path.posix.normalize(value) === value &&
  !/[\0\r\n\\]/.test(value);

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
      PRIMARY KEY(library_id,rating_key)
    ) STRICT`);
    db.exec(`CREATE TABLE IF NOT EXISTS plex_part_candidates (
      library_id INTEGER NOT NULL,
      rating_key INTEGER NOT NULL,
      part_id INTEGER NOT NULL CHECK(part_id>0),
      file_size INTEGER NOT NULL CHECK(file_size>0),
      plex_path TEXT NOT NULL,
      PRIMARY KEY(library_id,rating_key,part_id),
      FOREIGN KEY(library_id,rating_key)
        REFERENCES plex_card_observations(library_id,rating_key)
    ) STRICT`);
    db.exec('CREATE INDEX IF NOT EXISTS plex_candidate_size ON plex_part_candidates(file_size,library_id,rating_key)');
    db.exec(`CREATE TABLE IF NOT EXISTS plex_card_cursors (
      library_id INTEGER NOT NULL CHECK(library_id>0),
      kind TEXT NOT NULL CHECK(kind IN ('episode','movie')),
      offset INTEGER NOT NULL CHECK(offset>=0),
      PRIMARY KEY(library_id,kind)
    ) STRICT`);
    db.exec('PRAGMA foreign_keys=ON');
  } catch (error) { db.close(); throw error; }
  const previous = db.prepare(`SELECT observed_ms FROM plex_card_observations
    WHERE library_id=? AND rating_key=?`);
  const saveCard = db.prepare(`INSERT INTO plex_card_observations
    (library_id,rating_key,kind,observed_ms) VALUES (?,?,?,?)
    ON CONFLICT(library_id,rating_key) DO UPDATE SET
    kind=excluded.kind,observed_ms=excluded.observed_ms`);
  const clearParts = db.prepare(`DELETE FROM plex_part_candidates
    WHERE library_id=? AND rating_key=?`);
  const addPart = db.prepare(`INSERT INTO plex_part_candidates
    (library_id,rating_key,part_id,file_size,plex_path) VALUES (?,?,?,?,?)`);
  const cursor = db.prepare(`SELECT offset FROM plex_card_cursors
    WHERE library_id=? AND kind=?`);
  const saveCursor = db.prepare(`INSERT INTO plex_card_cursors
    (library_id,kind,offset) VALUES (?,?,?) ON CONFLICT(library_id,kind)
    DO UPDATE SET offset=excluded.offset`);
  const candidateQueries = new Map();
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
  return {
    recordCard({ libraryId, ratingKey, kind, parts, observedMs }) {
      if (!validId(libraryId) || !validId(ratingKey) ||
          !['episode', 'movie'].includes(kind) ||
          !Number.isSafeInteger(observedMs) || observedMs < 0 ||
          !Array.isArray(parts) || parts.length < 1 || parts.length > 400 ||
          parts.some((part) => !validId(part?.partId) ||
            part.libraryId !== libraryId || !validId(part.size) ||
            !validPath(part.plexPath)) ||
          new Set(parts.map((part) => part.partId)).size !== parts.length) {
        throw new TypeError('Invalid Plex card observation');
      }
      let begun = false;
      try {
        db.exec('BEGIN IMMEDIATE'); begun = true;
        const old = previous.get(libraryId, ratingKey);
        if (old && old.observed_ms >= observedMs) {
          db.exec('ROLLBACK'); begun = false;
          return { state: 'stale_card' };
        }
        saveCard.run(libraryId, ratingKey, kind, observedMs);
        clearParts.run(libraryId, ratingKey);
        for (const part of parts) addPart.run(libraryId, ratingKey,
          part.partId, part.size, part.plexPath);
        db.exec('COMMIT'); begun = false;
        return { state: 'recorded_card' };
      } catch (error) {
        if (begun) db.exec('ROLLBACK');
        throw error;
      }
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
    getCursor({ libraryId, kind }) {
      if (!validId(libraryId) || !['episode', 'movie'].includes(kind)) {
        throw new TypeError('Invalid Plex cursor');
      }
      return cursor.get(libraryId, kind)?.offset ?? 0;
    },
    advanceCursor({ libraryId, kind, expectedOffset, nextOffset }) {
      if (!validId(libraryId) || !['episode', 'movie'].includes(kind) ||
          !Number.isSafeInteger(expectedOffset) || expectedOffset < 0 ||
          !Number.isSafeInteger(nextOffset) || nextOffset < 0) {
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
