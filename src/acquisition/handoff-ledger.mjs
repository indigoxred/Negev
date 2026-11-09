import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { evaluateHandoffEvidence } from './handoff-evidence.mjs';

const held = (reason) => ({ state: 'held', reason });
const validId = (value) => Number.isSafeInteger(value) && value > 0;
const validTime = (value) => Number.isSafeInteger(value) && value >= 0;
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
    for (const table of ['acquisition_attempts', 'acquisition_starts',
      'acquisition_rejections']) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
        throw new TypeError('Acquisition ledger must be initialized first');
      }
    }
    db.exec(`CREATE TABLE IF NOT EXISTS handoff_intents (
      attempt_id INTEGER PRIMARY KEY REFERENCES acquisition_attempts(id),
      torrent_hash TEXT NOT NULL,
      evidence_digest TEXT NOT NULL,
      holding_path TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      publish_name TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK(status IN ('prepared','publish_unknown','published_observed')),
      created_ms INTEGER NOT NULL CHECK(created_ms >= 0),
      updated_ms INTEGER NOT NULL CHECK(updated_ms >= created_ms)
    ) STRICT`);
    db.exec(`CREATE TABLE IF NOT EXISTS handoff_content_observations (
      attempt_id INTEGER PRIMARY KEY REFERENCES handoff_intents(attempt_id),
      evidence_digest TEXT NOT NULL,
      file_ids_json TEXT NOT NULL,
      observed_ms INTEGER NOT NULL CHECK(observed_ms >= 0)
    ) STRICT`);
    if (!db.prepare('PRAGMA table_info(handoff_intents)').all()
      .some((column) => column.name === 'manifest_json')) {
      // Older private diagnostics remain held; their missing manifest cannot
      // be reconstructed from a digest alone.
      db.exec('ALTER TABLE handoff_intents ADD COLUMN manifest_json TEXT');
    }
  } catch (error) { db.close(); throw error; }

  const attemptRow = db.prepare('SELECT anidb_id,status,expected_hash,torrent_hash,updated_ms FROM acquisition_attempts WHERE id=?');
  const claimedEpisodes = db.prepare(`SELECT episode_id FROM acquisition_target_claims
    WHERE attempt_id=? AND active=1 ORDER BY episode_id`);
  const startRow = db.prepare('SELECT torrent_hash FROM acquisition_starts WHERE attempt_id=?');
  const rejectionRow = db.prepare('SELECT 1 FROM acquisition_rejections WHERE attempt_id=?');
  const handoffRow = db.prepare(`SELECT torrent_hash,evidence_digest,holding_path,manifest_json,
    publish_name,status,updated_ms
    FROM handoff_intents WHERE attempt_id=?`);
  const insertHandoff = db.prepare(`INSERT INTO handoff_intents
    (attempt_id,torrent_hash,evidence_digest,holding_path,manifest_json,publish_name,
      status,created_ms,updated_ms)
    VALUES (?,?,?,?,?,?,'prepared',?,?)`);
  const markUnknown = db.prepare(`UPDATE handoff_intents SET status='publish_unknown',updated_ms=?
    WHERE attempt_id=? AND status='prepared'`);
  const markObserved = db.prepare(`UPDATE handoff_intents SET status='published_observed',updated_ms=?
    WHERE attempt_id=? AND status='publish_unknown'`);
  const contentRow = db.prepare(`SELECT evidence_digest,file_ids_json FROM handoff_content_observations
    WHERE attempt_id=?`);
  const insertContent = db.prepare(`INSERT INTO handoff_content_observations
    (attempt_id,evidence_digest,file_ids_json,observed_ms) VALUES (?,?,?,?)`);

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

  function validStoredManifest(row) {
    if (typeof row?.manifest_json !== 'string') return null;
    try {
      const manifest = JSON.parse(row.manifest_json);
      const evidence = evaluateHandoffEvidence({ anidbId: manifest.anidbId,
        torrentHash: manifest.torrentHash, files: manifest.videos,
        subtitles: manifest.subtitles });
      return evidence.state === 'valid' &&
        JSON.stringify(manifest) === JSON.stringify(evidence.manifest) &&
        evidence.digest === row.evidence_digest &&
        evidence.manifest.torrentHash === row.torrent_hash ? evidence.manifest : null;
    } catch { return null; }
  }

  return {
    recordPrepared({ attemptId, prepared, nowMs }) {
      if (!validId(attemptId) || !validTime(nowMs) ||
          prepared?.state !== 'handoff_prepared' || prepared.publishReady !== false ||
          !validDigest(prepared.evidenceDigest) ||
          typeof prepared.holdingPath !== 'string' || !path.isAbsolute(prepared.holdingPath) ||
          prepared.holdingPath.length > 4096 || prepared.holdingPath.includes('\0')) {
        throw new TypeError('Invalid prepared handoff');
      }
      const evidence = evaluateHandoffEvidence(prepared);
      if (evidence.state !== 'valid' || evidence.digest !== prepared.evidenceDigest.toLowerCase()) {
        return held('handoff_evidence_mismatch');
      }
      const torrentHash = evidence.manifest.torrentHash;
      const evidenceDigest = evidence.digest;
      const holdingPath = prepared.holdingPath;
      return transact(() => {
        const attempt = attemptRow.get(attemptId);
        if (!attempt || attempt.status !== 'torrent_observed' ||
            attempt.expected_hash !== torrentHash ||
            attempt.torrent_hash !== torrentHash ||
            startRow.get(attemptId)?.torrent_hash !== torrentHash) {
          return held('start_intent_missing');
        }
        if (rejectionRow.get(attemptId)) return held('candidate_rejected');
        const claims = claimedEpisodes.all(attemptId).map((row) => row.episode_id);
        const covered = evidence.manifest.videos.flatMap((file) => file.episodeIds);
        if (evidence.manifest.anidbId !== attempt.anidb_id ||
            claims.length === 0 || covered.length !== claims.length ||
            new Set(covered).size !== covered.length ||
            covered.some((episodeId) => !claims.includes(episodeId))) {
          return held('target_claim_mismatch');
        }
        if (nowMs < attempt.updated_ms) return held('time_before_last_transition');
        const digest = evidenceDigest;
        const existing = handoffRow.get(attemptId);
        if (existing) {
          if (!validStoredManifest(existing)) return held('manifest_missing');
          if (existing.torrent_hash !== torrentHash ||
              existing.evidence_digest !== digest || existing.holding_path !== holdingPath) {
            return held('handoff_conflict');
          }
          return { state: existing.status, publishName: existing.publish_name };
        }
        const publishName = `negev-${attemptId}-${digest.slice(0, 16)}`;
        insertHandoff.run(attemptId, torrentHash, digest, holdingPath,
          JSON.stringify(evidence.manifest), publishName, nowMs, nowMs);
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
        if (!validStoredManifest(row)) return held('manifest_missing');
        if (nowMs < row.updated_ms) return held('time_before_last_transition');
        if (row.status === 'prepared') {
          markUnknown.run(nowMs, attemptId);
          return { state: 'publish_unknown', publishName: row.publish_name, sendNow: true };
        }
        return { state: row.status, publishName: row.publish_name, sendNow: false };
      });
    },
    // Caller must first prove the exact pre-rename bytes and a successful
    // watched-folder rename, or reconcile an unknown outcome by proving the
    // exact published directory. This records exposure, not Shoko import or playback.
    markPublishedObserved({ attemptId, evidenceDigest, publishName, nowMs }) {
      if (!validId(attemptId) || !validDigest(evidenceDigest) ||
          typeof publishName !== 'string' || !/^negev-[1-9]\d*-[0-9a-f]{16}$/.test(publishName) ||
          !validTime(nowMs)) throw new TypeError('Invalid published observation');
      return transact(() => {
        const row = handoffRow.get(attemptId);
        if (!row) return held('handoff_missing');
        if (row.evidence_digest !== evidenceDigest.toLowerCase() ||
            row.publish_name !== publishName) return held('handoff_conflict');
        if (!validStoredManifest(row)) return held('manifest_missing');
        if (nowMs < row.updated_ms) return held('time_before_last_transition');
        if (row.status === 'published_observed') return { state: 'published_observed' };
        if (row.status !== 'publish_unknown') return held('publish_intent_missing');
        markObserved.run(nowMs, attemptId);
        return { state: 'published_observed' };
      });
    },
    // This records exact downstream content after a durable publish intent.
    // It does not prove that this handoff supplied it or that Plex can play it.
    recordContentPresent({ attemptId, evidenceDigest, publishName, fileIds, nowMs }) {
      if (!validId(attemptId) || !validDigest(evidenceDigest) ||
          typeof publishName !== 'string' || !/^negev-[1-9]\d*-[0-9a-f]{16}$/.test(publishName) ||
          !Array.isArray(fileIds) || fileIds.length < 1 || fileIds.length > 100 ||
          fileIds.some((id) => !validId(id)) ||
          new Set(fileIds).size !== fileIds.length || !validTime(nowMs)) {
        throw new TypeError('Invalid content observation');
      }
      return transact(() => {
        const row = handoffRow.get(attemptId);
        if (!row || row.status !== 'publish_unknown') return held('publish_intent_missing');
        const manifest = validStoredManifest(row);
        if (!manifest || row.evidence_digest !== evidenceDigest.toLowerCase() ||
            row.publish_name !== publishName || fileIds.length !== manifest.videos.length) {
          return held('handoff_evidence_mismatch');
        }
        if (nowMs < row.updated_ms) return held('time_before_last_transition');
        const prior = contentRow.get(attemptId);
        if (prior) {
          if (prior.evidence_digest !== row.evidence_digest ||
              prior.file_ids_json !== JSON.stringify(fileIds)) {
            return held('content_observation_conflict');
          }
        } else insertContent.run(attemptId, row.evidence_digest,
          JSON.stringify(fileIds), nowMs);
        return { state: 'content_present', publicationProven: false, fileIds };
      });
    },
    getContentObservation(attemptId) {
      if (!validId(attemptId)) throw new TypeError('Invalid attempt ID');
      const row = contentRow.get(attemptId);
      if (!row) return null;
      const fileIds = JSON.parse(row.file_ids_json);
      return { state: 'content_present', publicationProven: false,
        evidenceDigest: row.evidence_digest, fileIds };
    },
    getHandoff(attemptId) {
      if (!validId(attemptId)) throw new TypeError('Invalid attempt ID');
      const row = handoffRow.get(attemptId);
      return row ? { status: row.status, torrentHash: row.torrent_hash,
        evidenceDigest: row.evidence_digest, holdingPath: row.holding_path,
        publishName: row.publish_name, manifest: validStoredManifest(row) } : null;
    },
    close() { db.close(); },
  };
}
