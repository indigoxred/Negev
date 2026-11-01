import { DatabaseSync } from 'node:sqlite';

const validId = (value) => Number.isSafeInteger(value) && value > 0;
const validTime = (value) => Number.isSafeInteger(value) && value >= 0;
const held = () => ({ state: 'held', reason: 'invalid_exact_proof' });

// Positive evidence from the internal exact Shoko/public Plex same-file
// observer. A stale proof is retained as history, never presented as current.
export function openFileProofLedger(dbPath, { positiveLifetimeMs,
  now = Date.now } = {}) {
  if (typeof dbPath !== 'string' || !dbPath || dbPath === ':memory:' ||
      !Number.isSafeInteger(positiveLifetimeMs) ||
      positiveLifetimeMs < 1 || positiveLifetimeMs > 7 * 24 * 60 * 60_000 ||
      typeof now !== 'function') {
    throw new TypeError('Invalid file proof ledger configuration');
  }
  const db = new DatabaseSync(dbPath, { timeout: 5_000 });
  try {
    db.exec('PRAGMA journal_mode=WAL');
    db.exec(`CREATE TABLE IF NOT EXISTS file_availability_proofs (
      anidb_id INTEGER NOT NULL CHECK(anidb_id>0),
      episode_id INTEGER NOT NULL CHECK(episode_id>0),
      file_id INTEGER NOT NULL CHECK(file_id>0),
      library_id INTEGER NOT NULL CHECK(library_id>0),
      rating_key INTEGER NOT NULL CHECK(rating_key>0),
      part_id INTEGER NOT NULL CHECK(part_id>0),
      verified_ms INTEGER NOT NULL CHECK(verified_ms>=0),
      PRIMARY KEY(anidb_id,episode_id,file_id,library_id,rating_key,part_id)
    ) STRICT`);
    db.exec(`CREATE INDEX IF NOT EXISTS file_proof_episode
      ON file_availability_proofs(anidb_id,episode_id,verified_ms DESC)`);
    db.exec(`CREATE INDEX IF NOT EXISTS file_proof_file
      ON file_availability_proofs(file_id,verified_ms)`);
    db.exec(`CREATE INDEX IF NOT EXISTS file_proof_card
      ON file_availability_proofs(library_id,rating_key,verified_ms)`);
  } catch (error) { db.close(); throw error; }
  const upsert = db.prepare(`INSERT INTO file_availability_proofs
    (anidb_id,episode_id,file_id,library_id,rating_key,part_id,verified_ms)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT DO UPDATE SET
      verified_ms=excluded.verified_ms
    WHERE excluded.verified_ms>=file_availability_proofs.verified_ms`);
  const current = db.prepare(`SELECT MAX(verified_ms) AS verifiedMs
    FROM file_availability_proofs WHERE anidb_id=? AND episode_id=?
      AND verified_ms<=?`);
  return {
    observe({ anidbId, episodeId, proof, checkedMs } = {}) {
      const observedNow = now();
      if (!validId(anidbId) || !validId(episodeId) ||
          !validId(proof?.fileId) || !validId(proof.libraryId) ||
          !validId(proof.ratingKey) || !validId(proof.partId) ||
          !validTime(checkedMs) || !validTime(observedNow) ||
          checkedMs > observedNow) return held();
      const identity = [anidbId, episodeId, proof.fileId,
        proof.libraryId, proof.ratingKey, proof.partId];
      const saved = upsert.run(...identity, checkedMs);
      return { state: saved.changes === 1 ? 'recorded' : 'stale' };
    },
    getCurrent({ anidbId, episodeId } = {}) {
      if (!validId(anidbId) || !validId(episodeId)) {
        throw new TypeError('Invalid file proof target');
      }
      const nowMs = now();
      if (!validTime(nowMs)) throw new TypeError('Invalid file proof clock');
      const row = current.get(anidbId, episodeId, nowMs);
      if (!validTime(row?.verifiedMs)) return { state: 'unknown' };
      return { state: row.verifiedMs + positiveLifetimeMs > nowMs
        ? 'available' : 'previously_available',
      verifiedAtMs: row.verifiedMs };
    },
    close() { db.close(); },
  };
}
