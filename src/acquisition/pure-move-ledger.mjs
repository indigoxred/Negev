import { createHash } from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { torrentFileKind } from './evaluate-stopped-manifest.mjs';

const held = (reason) => ({ state: 'held', reason });
const HASH = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const validId = (value) => Number.isSafeInteger(value) && value > 0;
const validTime = (value) => Number.isSafeInteger(value) && value >= 0;
const digits = (value) => typeof value === 'string' && /^\d+$/.test(value);

function canonical(input) {
  if (!validId(input?.attemptId) || !HASH.test(input?.torrentHash) ||
      !path.isAbsolute(input?.stagingRoot ?? '') ||
      !path.isAbsolute(input?.holdingPath ?? '') ||
      path.basename(input.stagingRoot) !== input.torrentHash ||
      path.basename(input.holdingPath) !==
        `negev-${input.attemptId}-${input.torrentHash.slice(0, 16)}` ||
      !Array.isArray(input.files) || input.files.length < 1 || input.files.length > 100) {
    return null;
  }
  const names = new Set();
  const episodes = new Set();
  const files = [];
  for (const file of input.files) {
    const kind = torrentFileKind(file?.name);
    if (!['video', 'subtitle'].includes(kind) || names.has(file.name.toLowerCase()) ||
        !Number.isSafeInteger(file.size) || file.size < 1 ||
        !digits(file.dev) || !digits(file.ino) || !digits(file.mtimeNs) ||
        (kind === 'video' && (!Array.isArray(file.episodeIds) ||
          file.episodeIds.length < 1 || file.episodeIds.some((id) =>
            !validId(id) || episodes.has(id))))) return null;
    names.add(file.name.toLowerCase());
    if (kind === 'video') for (const id of file.episodeIds) episodes.add(id);
    files.push({ name: file.name, size: file.size,
      ...(kind === 'video' ? { episodeIds: [...file.episodeIds] } : {}),
      dev: file.dev, ino: file.ino, mtimeNs: file.mtimeNs });
  }
  if (episodes.size < 1) return null;
  files.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  const manifest = { attemptId: input.attemptId, torrentHash: input.torrentHash,
    stagingRoot: input.stagingRoot, holdingPath: input.holdingPath, files };
  const digest = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  return { manifest, digest, episodes };
}

export function openPureMoveLedger(dbPath) {
  if (typeof dbPath !== 'string' || !dbPath || dbPath === ':memory:') {
    throw new TypeError('Durable move database path required');
  }
  const db = new DatabaseSync(dbPath, { timeout: 5_000 });
  try {
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA foreign_keys=ON');
    for (const table of ['acquisition_attempts', 'acquisition_starts',
      'acquisition_target_claims']) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
        throw new TypeError('Acquisition ledger must be initialized first');
      }
    }
    db.exec(`CREATE TABLE IF NOT EXISTS pure_move_intents (
      attempt_id INTEGER PRIMARY KEY REFERENCES acquisition_attempts(id),
      torrent_hash TEXT NOT NULL,
      manifest_digest TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN
        ('moving','prepared','publish_unknown','published_observed')),
      created_ms INTEGER NOT NULL CHECK(created_ms>=0),
      updated_ms INTEGER NOT NULL CHECK(updated_ms>=created_ms)
    ) STRICT`);
  } catch (error) { db.close(); throw error; }
  const attempt = db.prepare(`SELECT status,torrent_hash,expected_hash,updated_ms
    FROM acquisition_attempts WHERE id=?`);
  const start = db.prepare('SELECT torrent_hash FROM acquisition_starts WHERE attempt_id=?');
  const claims = db.prepare(`SELECT episode_id FROM acquisition_target_claims
    WHERE attempt_id=? AND active=1 ORDER BY episode_id`);
  const hasLegacy = !!db.prepare(`SELECT name FROM sqlite_master
    WHERE type='table' AND name='handoff_intents'`).get();
  const old = hasLegacy
    ? db.prepare(`SELECT 1 FROM handoff_intents WHERE attempt_id=?`) : null;
  const get = db.prepare(`SELECT torrent_hash AS torrentHash,
    manifest_digest AS manifestDigest,manifest_json AS manifestJson,
    status,created_ms AS createdMs,updated_ms AS updatedMs
    FROM pure_move_intents WHERE attempt_id=?`);
  const insert = db.prepare(`INSERT INTO pure_move_intents
    (attempt_id,torrent_hash,manifest_digest,manifest_json,status,created_ms,updated_ms)
    VALUES (?,?,?,?,'moving',?,?)`);
  const transition = db.prepare(`UPDATE pure_move_intents SET status=?,updated_ms=?
    WHERE attempt_id=? AND status=?`);
  const transact = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  return {
    recordIntent(input) {
      const evidence = canonical(input);
      if (!evidence || !validTime(input.nowMs)) {
        throw new TypeError('Invalid move intent');
      }
      return transact(() => {
        const prior = get.get(input.attemptId);
        if (prior) return prior.manifestDigest === evidence.digest &&
            prior.manifestJson === JSON.stringify(evidence.manifest)
          ? { state: 'recorded' } : held('move_intent_conflict');
        if (old?.get(input.attemptId)) return held('legacy_handoff_exists');
        const a = attempt.get(input.attemptId);
        if (a?.status !== 'torrent_observed' ||
            a.torrent_hash !== input.torrentHash ||
            a.expected_hash !== input.torrentHash ||
            start.get(input.attemptId)?.torrent_hash !== input.torrentHash ||
            input.nowMs < a.updated_ms) return held('start_intent_missing');
        const expected = claims.all(input.attemptId).map((row) => row.episode_id);
        if (expected.length !== evidence.episodes.size ||
            expected.some((id) => !evidence.episodes.has(id))) {
          return held('target_claim_mismatch');
        }
        insert.run(input.attemptId, input.torrentHash, evidence.digest,
          JSON.stringify(evidence.manifest), input.nowMs, input.nowMs);
        return { state: 'recorded' };
      });
    },
    getIntent(attemptId) {
      if (!validId(attemptId)) throw new TypeError('Invalid move attempt');
      const row = get.get(attemptId);
      if (!row) return null;
      const manifest = JSON.parse(row.manifestJson);
      if (canonical(manifest)?.digest !== row.manifestDigest) {
        return { status: 'invalid_manifest' };
      }
      return { status: row.status, manifest,
        manifestDigest: row.manifestDigest, createdMs: row.createdMs,
        updatedMs: row.updatedMs };
    },
    markPrepared({ attemptId, nowMs }) {
      if (!validId(attemptId) || !validTime(nowMs)) throw new TypeError('Invalid move state');
      return transact(() => {
        const row = get.get(attemptId);
        if (!row || nowMs < row.updatedMs) return held('move_intent_missing');
        if (row.status === 'prepared') return { state: 'prepared' };
        return transition.run('prepared', nowMs, attemptId, 'moving').changes === 1
          ? { state: 'prepared' } : held('move_state_conflict');
      });
    },
    beginPublish({ attemptId, nowMs }) {
      if (!validId(attemptId) || !validTime(nowMs)) throw new TypeError('Invalid publish state');
      return transact(() => {
        const row = get.get(attemptId);
        if (!row || nowMs < row.updatedMs) return held('move_intent_missing');
        if (row.status === 'publish_unknown') {
          return { state: 'publish_unknown', sendNow: false };
        }
        return transition.run('publish_unknown', nowMs, attemptId, 'prepared').changes === 1
          ? { state: 'publish_unknown', sendNow: true }
          : held('move_state_conflict');
      });
    },
    markPublished({ attemptId, nowMs }) {
      if (!validId(attemptId) || !validTime(nowMs)) throw new TypeError('Invalid publish state');
      return transact(() => {
        const row = get.get(attemptId);
        if (!row || nowMs < row.updatedMs) return held('move_intent_missing');
        if (row.status === 'published_observed') return { state: 'published_observed' };
        return transition.run('published_observed', nowMs, attemptId,
          'publish_unknown').changes === 1
          ? { state: 'published_observed' } : held('move_state_conflict');
      });
    },
    close() { db.close(); },
  };
}
