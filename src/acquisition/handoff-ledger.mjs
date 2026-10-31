import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const held = (reason) => ({ state: 'held', reason });
const validId = (value) => Number.isSafeInteger(value) && value > 0;
const validTime = (value) => Number.isSafeInteger(value) && value >= 0;
const validHash = (value) => typeof value === 'string' &&
  /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(value);
const validDigest = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);

// Records durable intent before a future whole-directory rename. It does not
// check file bytes, perform a rename, or declare Shoko import successful.
export function openHandoffLedger(dbPath) {
  if (typeof dbPath !== 'string' || !dbPath || dbPath === ':memory:') {
    throw new TypeError('A durable handoff database path is required');
  }
  const db = new DatabaseSync(dbPath, { timeout: 5_000 });
  try {
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA foreign_keys=ON');
    for (const table of ['acquisition_attempts', 'acquisition_starts']) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
        throw new TypeError('Acquisition ledger must be initialized first');
      }
    }
    db.exec(`CREATE TABLE IF NOT EXISTS handoff_intents (
      attempt_id INTEGER PRIMARY KEY REFERENCES acquisition_attempts(id),
      torrent_hash TEXT NOT NULL,
      evidence_digest TEXT NOT NULL,
      holding_path TEXT NOT NULL,
      publish_name TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK(status IN ('prepared','publish_unknown','published_observed')),
      created_ms INTEGER NOT NULL CHECK(created_ms >= 0),
      updated_ms INTEGER NOT NULL CHECK(updated_ms >= created_ms)
    ) STRICT`);
  } catch (error) { db.close(); throw error; }

  const attemptRow = db.prepare('SELECT status,expected_hash,torrent_hash,updated_ms FROM acquisition_attempts WHERE id=?');
  const startRow = db.prepare('SELECT torrent_hash FROM acquisition_starts WHERE attempt_id=?');
  const handoffRow = db.prepare(`SELECT torrent_hash,evidence_digest,holding_path,publish_name,status,updated_ms
    FROM handoff_intents WHERE attempt_id=?`);
  const insertHandoff = db.prepare(`INSERT INTO handoff_intents
    (attempt_id,torrent_hash,evidence_digest,holding_path,publish_name,status,created_ms,updated_ms)
    VALUES (?,?,?,?,?,'prepared',?,?)`);
  const markUnknown = db.prepare(`UPDATE handoff_intents SET status='publish_unknown',updated_ms=?
    WHERE attempt_id=? AND status='prepared'`);

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
    recordPrepared({ attemptId, torrentHash, evidenceDigest, holdingPath, nowMs }) {
      if (!validId(attemptId) || !validHash(torrentHash) ||
          !validDigest(evidenceDigest) || !validTime(nowMs) ||
          typeof holdingPath !== 'string' || !path.isAbsolute(holdingPath) ||
          holdingPath.length > 4096 || holdingPath.includes('\0')) {
        throw new TypeError('Invalid prepared handoff');
      }
      return transact(() => {
        const attempt = attemptRow.get(attemptId);
        if (!attempt || attempt.status !== 'torrent_observed' ||
            attempt.expected_hash !== torrentHash.toLowerCase() ||
            attempt.torrent_hash !== torrentHash.toLowerCase() ||
            startRow.get(attemptId)?.torrent_hash !== torrentHash.toLowerCase()) {
          return held('start_intent_missing');
        }
        if (nowMs < attempt.updated_ms) return held('time_before_last_transition');
        const digest = evidenceDigest.toLowerCase();
        const existing = handoffRow.get(attemptId);
        if (existing) {
          if (existing.torrent_hash !== torrentHash.toLowerCase() ||
              existing.evidence_digest !== digest || existing.holding_path !== holdingPath) {
            return held('handoff_conflict');
          }
          return { state: existing.status, publishName: existing.publish_name };
        }
        const publishName = `negev-${attemptId}-${digest.slice(0, 16)}`;
        insertHandoff.run(attemptId, torrentHash.toLowerCase(), digest,
          holdingPath, publishName, nowMs, nowMs);
        return { state: 'prepared', publishName };
      });
    },
    beginPublish({ attemptId, evidenceDigest, nowMs }) {
      if (!validId(attemptId) || !validDigest(evidenceDigest) || !validTime(nowMs)) {
        throw new TypeError('Invalid publish intent');
      }
      return transact(() => {
        const row = handoffRow.get(attemptId);
        if (!row) return held('handoff_missing');
        if (row.evidence_digest !== evidenceDigest.toLowerCase()) return held('handoff_conflict');
        if (nowMs < row.updated_ms) return held('time_before_last_transition');
        if (row.status === 'prepared') {
          markUnknown.run(nowMs, attemptId);
          return { state: 'publish_unknown', publishName: row.publish_name, sendNow: true };
        }
        return { state: row.status, publishName: row.publish_name, sendNow: false };
      });
    },
    getHandoff(attemptId) {
      if (!validId(attemptId)) throw new TypeError('Invalid attempt ID');
      const row = handoffRow.get(attemptId);
      return row ? { status: row.status, torrentHash: row.torrent_hash,
        evidenceDigest: row.evidence_digest, holdingPath: row.holding_path,
        publishName: row.publish_name } : null;
    },
    close() { db.close(); },
  };
}
