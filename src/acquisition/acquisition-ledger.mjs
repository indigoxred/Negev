import { selectMissingFiles } from './select-missing-files.mjs';
import { pendingRecognitionSql } from './recognition-release-sql.mjs';
import { canonicalReleaseGuid } from './durable-release-candidate.mjs';
import { MAX_ACQUISITION_VIDEOS, MAX_ACQUISITION_TARGETS } from './torrent-file-limits.mjs';
import { createBonusPackLedger } from './bonus-pack-ledger.mjs';
import { createTorrentSelectionLedger } from './torrent-selection-ledger.mjs';
import { createHash } from 'node:crypto';
import { releaseReservationGate } from './release-control.mjs';
import { DatabaseSync } from 'node:sqlite';
import { torrentFileKind } from './evaluate-stopped-manifest.mjs';
import { MAX_RELEASE_GUID_LENGTH } from './release-candidate-limits.mjs';
import { allocateDurableId } from '../runtime/durable-id.mjs';
import { requestAccessHold } from './request-owner.mjs';

const held = (reason) => ({ state: 'held', reason });
const validTime = (value) => Number.isSafeInteger(value) && value >= 0;
const validId = (value) => Number.isSafeInteger(value) && value > 0;
const validHash = (value) => typeof value === 'string' &&
  /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(value);

function canonicalFilePlan(plannedFiles) {
  if (!Array.isArray(plannedFiles) || plannedFiles.length < 1 || plannedFiles.length > MAX_ACQUISITION_VIDEOS) {
    throw new TypeError('Invalid acquisition file plan');
  }
  const names = new Set();
  const targets = new Set();
  const files = plannedFiles.map((file) => {
    if (typeof file?.name !== 'string' || file.name.length > 1000 ||
        torrentFileKind(file.name) !== 'video' ||
        !Number.isSafeInteger(file.size) || file.size < 1 || file.size > 1024 ** 4 ||
        !Array.isArray(file.episodeIds) || file.episodeIds.length < 1 ||
        file.episodeIds.length > MAX_ACQUISITION_TARGETS || file.episodeIds.some((id) => !validId(id))) {
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
    // Created here as well as in the request queue so standalone downstream
    // queues can test a saved cutover hold before their first claim.
    db.exec(`CREATE TABLE IF NOT EXISTS acquisition_request_suspensions (
      request_id INTEGER PRIMARY KEY REFERENCES requests(id),
      reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 80),
      recorded_ms INTEGER NOT NULL CHECK(recorded_ms>=0)
    ) STRICT`);
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
    db.exec('CREATE INDEX IF NOT EXISTS acquisition_attempts_by_request ON acquisition_attempts(request_id)');
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
    // A torrent retired as the wrong installment can later be requested for
    // its correct AniDB title. Keep the historical hash, and enforce active
    // exclusivity in the immediate reservation transaction below.
    const hashIndex = db.prepare('PRAGMA index_list(acquisition_attempts)').all()
      .find((index) => index.name === 'acquisition_expected_hash');
    if (hashIndex?.unique === 1) db.exec('DROP INDEX acquisition_expected_hash');
    db.exec(`CREATE INDEX IF NOT EXISTS acquisition_expected_hash
      ON acquisition_attempts(expected_hash) WHERE expected_hash IS NOT NULL`);
    db.exec(`CREATE TABLE IF NOT EXISTS acquisition_dispatch_refusals (
      attempt_id INTEGER PRIMARY KEY REFERENCES acquisition_attempts(id),
      anidb_id INTEGER NOT NULL,indexer_id INTEGER NOT NULL,
      candidate_base TEXT NOT NULL,torrent_hash TEXT NOT NULL,
      refused_ms INTEGER NOT NULL CHECK(refused_ms>=0),
      http_status INTEGER NOT NULL CHECK(http_status=403)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS dispatch_refusal_candidate
      ON acquisition_dispatch_refusals(indexer_id,anidb_id,candidate_base,attempt_id DESC)`);
    db.exec(`CREATE TABLE IF NOT EXISTS acquisition_target_claims (
      attempt_id INTEGER NOT NULL REFERENCES acquisition_attempts(id),
      anidb_id INTEGER NOT NULL CHECK(anidb_id > 0),
      episode_id INTEGER NOT NULL CHECK(episode_id > 0),
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      PRIMARY KEY(attempt_id,episode_id)
    ) STRICT`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS active_acquisition_target
      ON acquisition_target_claims(anidb_id,episode_id) WHERE active=1`);
    db.exec(`CREATE TABLE IF NOT EXISTS recognition_recoveries (
      attempt_id INTEGER PRIMARY KEY REFERENCES acquisition_attempts(id),
      file_id INTEGER NOT NULL CHECK(file_id>0),
      status TEXT NOT NULL CHECK(status IN
        ('observed','preserve_unknown','preserved','released')),
      first_seen_ms INTEGER NOT NULL CHECK(first_seen_ms>=0),
      updated_ms INTEGER NOT NULL CHECK(updated_ms>=first_seen_ms)
    ) STRICT`);
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
    if (!db.prepare('PRAGMA table_info(acquisition_starts)').all().some(c=>c.name==='send_token')) {
      db.exec('ALTER TABLE acquisition_starts ADD COLUMN send_token TEXT');
    }
    db.exec(`CREATE TABLE IF NOT EXISTS acquisition_start_rejections (
      send_token TEXT PRIMARY KEY,
      attempt_id INTEGER NOT NULL REFERENCES acquisition_attempts(id),
      torrent_hash TEXT NOT NULL,
      manifest_digest TEXT NOT NULL,
      rejected_ms INTEGER NOT NULL CHECK(rejected_ms>=0),
      http_status INTEGER NOT NULL CHECK(http_status=403)
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
        CHECK(reason IN ('file_wrong_identity','stalled_download','media_tracks_unsuitable','policy_reset')),
      retired_ms INTEGER NOT NULL CHECK(retired_ms >= 0)
    ) STRICT`);
    if (!db.prepare('PRAGMA table_info(acquisition_retirements)').all()
      .some((column) => column.name === 'reason')) {
      db.exec("ALTER TABLE acquisition_retirements ADD COLUMN reason TEXT NOT NULL DEFAULT 'file_wrong_identity' CHECK(reason IN ('file_wrong_identity','stalled_download'))");
    }
    if (!db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='acquisition_retirements'")
      .get().sql.includes('policy_reset')) {
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE acquisition_retirements_new (
          attempt_id INTEGER PRIMARY KEY REFERENCES acquisition_attempts(id),
          torrent_hash TEXT NOT NULL,
          reason TEXT NOT NULL DEFAULT 'file_wrong_identity'
            CHECK(reason IN ('file_wrong_identity','stalled_download','media_tracks_unsuitable','policy_reset')),
          retired_ms INTEGER NOT NULL CHECK(retired_ms >= 0)
        ) STRICT;
        INSERT INTO acquisition_retirements_new
          SELECT attempt_id,torrent_hash,reason,retired_ms FROM acquisition_retirements;
        DROP TABLE acquisition_retirements;
        ALTER TABLE acquisition_retirements_new RENAME TO acquisition_retirements;
        COMMIT;`);
    }
    db.exec(`CREATE TABLE IF NOT EXISTS acquisition_prestart_mismatch_retirements (
      attempt_id INTEGER PRIMARY KEY REFERENCES acquisition_attempts(id),
      retired_ms INTEGER NOT NULL CHECK(retired_ms >= 0)
    ) STRICT`);
    db.exec(`CREATE TABLE IF NOT EXISTS acquisition_stall_retirement_intents (
      attempt_id INTEGER PRIMARY KEY REFERENCES acquisition_attempts(id),
      torrent_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('requested','delete_unknown')),
      created_ms INTEGER NOT NULL CHECK(created_ms >= 0),
      updated_ms INTEGER NOT NULL CHECK(updated_ms >= created_ms)
    ) STRICT`);
    db.exec(`CREATE TABLE IF NOT EXISTS acquisition_media_retirement_intents (
      attempt_id INTEGER PRIMARY KEY REFERENCES acquisition_attempts(id),
      torrent_hash TEXT NOT NULL,
      reason TEXT NOT NULL CHECK(reason IN
        ('japanese_audio_missing','english_full_subtitles_missing',
         'outside_quality_profile','audio_language_unverified',
         'resolution_unavailable','media_tracks_unverified')),
      status TEXT NOT NULL CHECK(status IN ('requested','delete_unknown')),
      created_ms INTEGER NOT NULL CHECK(created_ms >= 0),
      updated_ms INTEGER NOT NULL CHECK(updated_ms >= created_ms)
    ) STRICT`);
  } catch (error) { db.close(); throw error; }

  let bonuses, selections;
  try {
    bonuses = createBonusPackLedger(db);
    selections = createTorrentSelectionLedger(db, transact);
  } catch(error) { db.close();throw error; }
  const requestRow = db.prepare('SELECT id,anidb_id,status FROM requests WHERE id=?');
  const attemptForRequest = db.prepare(`SELECT 1 AS present
    FROM acquisition_attempts attempt
    LEFT JOIN acquisition_releases released ON released.attempt_id=attempt.id
    LEFT JOIN acquisition_retirements retired ON retired.attempt_id=attempt.id
    WHERE attempt.request_id=? AND released.attempt_id IS NULL AND
      retired.attempt_id IS NULL AND ${pendingRecognitionSql(db, 'attempt')} LIMIT 1`);
  const requestedEpisode = db.prepare(`SELECT 1 AS present FROM request_targets rt
    JOIN targets t ON t.id=rt.target_id
    WHERE rt.request_id=? AND t.anidb_id=? AND t.episode_id=? LIMIT 1`);
  const candidateRow = db.prepare('SELECT id,request_id,anidb_id,status,evidence_policy,expected_hash,updated_ms FROM acquisition_attempts WHERE indexer_id=? AND candidate_digest=?');
  const busyTarget = db.prepare(`WITH target(aid,eid) AS (VALUES (?,?))
    SELECT c.attempt_id FROM acquisition_target_claims c,target WHERE c.anidb_id=target.aid AND c.episode_id=target.eid AND c.active=1
    UNION ALL SELECT b.attempt_id FROM acquisition_bonus_files b,target WHERE b.anidb_id=target.aid AND b.episode_id=target.eid AND b.active=1 LIMIT 1`);
  const historicalTarget = db.prepare(`SELECT claim.attempt_id
    FROM acquisition_target_claims claim
    LEFT JOIN acquisition_releases released ON released.attempt_id=claim.attempt_id
    LEFT JOIN acquisition_retirements retired ON retired.attempt_id=claim.attempt_id
    LEFT JOIN recognition_recoveries recovery ON recovery.attempt_id=claim.attempt_id
    WHERE claim.anidb_id=? AND claim.episode_id=?
      AND released.attempt_id IS NULL AND retired.attempt_id IS NULL
      AND (recovery.attempt_id IS NULL OR recovery.status<>'released') LIMIT 1`);
  const replacementAlreadyUsed = db.prepare(`SELECT 1
    FROM recognition_recoveries recovery
    JOIN acquisition_target_claims original ON
      original.attempt_id=recovery.attempt_id
    JOIN acquisition_target_claims later ON
      later.anidb_id=original.anidb_id AND
      later.episode_id=original.episode_id AND
      later.attempt_id<>original.attempt_id
    JOIN acquisition_attempts attempt ON attempt.id=later.attempt_id
    WHERE recovery.status='released' AND attempt.request_id=? AND
      original.anidb_id=? AND original.episode_id=? AND NOT EXISTS
        (SELECT 1 FROM acquisition_dispatch_refusals d WHERE d.attempt_id=attempt.id) LIMIT 1`);
  const busyHash = db.prepare(`SELECT a.id FROM acquisition_attempts a
    LEFT JOIN acquisition_retirements r ON r.attempt_id=a.id
    WHERE a.expected_hash=? AND a.id<>? AND NOT EXISTS
      (SELECT 1 FROM acquisition_dispatch_refusals d JOIN acquisition_releases released
        ON released.attempt_id=d.attempt_id WHERE d.attempt_id=a.id) AND
      (r.reason IS NULL OR r.reason NOT IN ('file_wrong_identity','policy_reset')
        OR (r.reason='file_wrong_identity' AND a.anidb_id=?))
    LIMIT 1`);
  const insertAttempt = db.prepare(`INSERT INTO acquisition_attempts
    (id,request_id,anidb_id,indexer_id,candidate_digest,status,evidence_policy,created_ms,updated_ms)
    VALUES (?,?,?,?,?,'reserved',?,?,?)`);
  const claimTarget = db.prepare('INSERT INTO acquisition_target_claims(attempt_id,anidb_id,episode_id) VALUES (?,?,?)');
  // Why a never-started attempt may be retired before its start: a recorded
  // wrong-installment check, or an admin release of that exact parked check.
  const hasTable = (name) => Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  const prestartRetirementBasis = (attemptId) => {
    if (!hasTable('start_checks')) return null;
    if (db.prepare(`SELECT 1 FROM start_checks WHERE attempt_id=? AND
      state='held' AND reason='related_installment_mismatch'`).get(attemptId)) {
      return 'mismatch';
    }
    if (hasTable('operator_review_actions') && db.prepare(`SELECT 1
      FROM start_checks c JOIN operator_review_actions o ON o.attempt_id=c.attempt_id
        AND o.stage='start' AND o.action='release' AND o.check_version=c.version
      WHERE c.attempt_id=? AND c.state='held' AND c.next_due_ms IS NULL`).get(attemptId)) {
      return 'operator_release';
    }
    return null;
  };
  const findAttempt = db.prepare(`SELECT id,request_id,anidb_id,indexer_id,candidate_digest,status,evidence_policy,expected_hash,torrent_hash,created_ms,updated_ms
    FROM acquisition_attempts WHERE id=?`);
  const attemptEpisodes = db.prepare('SELECT c.episode_id FROM acquisition_target_claims c WHERE c.attempt_id=? AND NOT EXISTS (SELECT 1 FROM acquisition_selection_excluded_targets e WHERE e.attempt_id=c.attempt_id AND e.episode_id=c.episode_id) ORDER BY c.episode_id');
  const activeAttemptEpisodes = db.prepare(`SELECT episode_id FROM acquisition_target_claims
    WHERE attempt_id=? AND active=1 ORDER BY episode_id`);
  const planRows = db.prepare('SELECT file_name,file_size,episode_key FROM acquisition_file_plans WHERE attempt_id=? ORDER BY file_name');
  const insertPlan = db.prepare('INSERT INTO acquisition_file_plans(attempt_id,file_name,file_size,episode_key) VALUES (?,?,?,?)');
  const touchAttempt = db.prepare('UPDATE acquisition_attempts SET updated_ms=? WHERE id=?');
  const findRelease = db.prepare('SELECT released_ms FROM acquisition_releases WHERE attempt_id=?');
  const findDispatchRefusal = db.prepare('SELECT torrent_hash,refused_ms,indexer_id,candidate_base FROM acquisition_dispatch_refusals WHERE attempt_id=?');
  const latestDispatchRefusal = db.prepare(`SELECT attempt_id FROM acquisition_dispatch_refusals
    WHERE indexer_id=? AND anidb_id=? AND candidate_base=? ORDER BY attempt_id DESC LIMIT 1`);
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
  const findRecovery = db.prepare(`SELECT status FROM recognition_recoveries
    WHERE attempt_id=?`);
  db.exec(`CREATE TABLE IF NOT EXISTS acquisition_candidate_aliases (
    indexer_id INTEGER NOT NULL,canonical_digest TEXT NOT NULL,legacy_digest TEXT NOT NULL,
    PRIMARY KEY(indexer_id,canonical_digest,legacy_digest)) STRICT`);
  const findAliasedDigests=db.prepare(`SELECT candidate_digest FROM acquisition_attempts WHERE indexer_id=? AND candidate_digest=?
    UNION SELECT a.candidate_digest FROM acquisition_candidate_aliases alias
    JOIN acquisition_attempts a ON a.indexer_id=alias.indexer_id AND a.candidate_digest=alias.legacy_digest
    WHERE alias.indexer_id=? AND alias.canonical_digest=?`);
  const aliasedDigest = (indexerId, canonicalDigest) => {
    const matches=findAliasedDigests.all(indexerId,canonicalDigest,indexerId,canonicalDigest);
    if(matches.length>1)throw new TypeError('Ambiguous legacy release identity');
    return matches[0]?.candidate_digest??canonicalDigest;
  };
  const digestForCandidate = (candidate, anidbId) => {
    const guid=canonicalReleaseGuid(candidate.guid,candidate.indexerId);
    const base=createHash('sha256').update(guid).digest('hex');
    const refused=latestDispatchRefusal.get(candidate.indexerId,anidbId,base);
    if(refused)return createHash('sha256').update(JSON.stringify(
      ['dispatch-refusal-retry-v1',anidbId,guid,refused.attempt_id])).digest('hex');
    const legacyDigest = aliasedDigest(candidate.indexerId,createHash('sha256').update(guid).digest('hex'));
    const legacy = candidateRow.get(candidate.indexerId, legacyDigest);
    if (legacy && findRetirement.get(legacy.id)?.reason === 'policy_reset') {
      return aliasedDigest(candidate.indexerId,createHash('sha256').update(JSON.stringify(
        ['release-policy-reset-v1', anidbId, guid])).digest('hex'));
    }
    if (legacy && legacy.anidb_id !== anidbId &&
        findRetirement.get(legacy.id)?.reason === 'file_wrong_identity') {
      return aliasedDigest(candidate.indexerId,createHash('sha256').update(JSON.stringify(
        ['wrong-installment-reassignment-v1', anidbId, guid])).digest('hex'));
    }
    return legacyDigest;
  };
  const findPrestartMismatchRetirement = db.prepare(
    'SELECT retired_ms FROM acquisition_prestart_mismatch_retirements WHERE attempt_id=?');
  const insertPrestartMismatchRetirement = db.prepare(
    'INSERT INTO acquisition_prestart_mismatch_retirements(attempt_id,retired_ms) VALUES (?,?)');
  const findStallIntent = db.prepare(`SELECT torrent_hash,status,created_ms,updated_ms
    FROM acquisition_stall_retirement_intents WHERE attempt_id=?`);
  const findMediaIntent = db.prepare(`SELECT torrent_hash,reason,status,created_ms,updated_ms
    FROM acquisition_media_retirement_intents WHERE attempt_id=?`);
  const insertMediaIntent = db.prepare(`INSERT INTO acquisition_media_retirement_intents
    (attempt_id,torrent_hash,reason,status,created_ms,updated_ms)
    VALUES (?,?,?,'requested',?,?)`);
  const beginMediaDelete = db.prepare(`UPDATE acquisition_media_retirement_intents
    SET status='delete_unknown',updated_ms=?
    WHERE attempt_id=? AND torrent_hash=? AND status='requested'`);
  const resetRejectedMediaDelete = db.prepare(`UPDATE acquisition_media_retirement_intents
    SET status='requested',updated_ms=?
    WHERE attempt_id=? AND torrent_hash=? AND status='delete_unknown'`);
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

  // Called only inside the reservation/revision transaction. Original target
  // claims and every prior file map remain available as historical evidence.
  function saveNarrowedSelection(attemptId, previous, remaining, removedIds, checkedMs, nowMs, selection) {
    const revision=db.prepare('SELECT COALESCE(MAX(revision),0)+1 n FROM acquisition_selection_revisions WHERE attempt_id=?').get(attemptId).n;
    db.prepare('INSERT INTO acquisition_selection_revisions VALUES (?,?,?,?,?,?,?)').run(attemptId,revision,
      JSON.stringify(previous),JSON.stringify(remaining),JSON.stringify(removedIds),checkedMs,nowMs);
    for (const id of removedIds) {
      db.prepare('INSERT INTO acquisition_selection_excluded_targets VALUES (?,?,?)').run(attemptId,id,nowMs);
      db.prepare('UPDATE acquisition_target_claims SET active=0 WHERE attempt_id=? AND episode_id=?').run(attemptId,id);
    }
    const names=new Set(remaining.map(file=>file.name));
    const removed=previous.filter(file=>!names.has(file.name));
    for (const file of removed) db.prepare('DELETE FROM acquisition_file_plans WHERE attempt_id=? AND file_name=?').run(attemptId,file.name);
    if (selection) {
      const excluded=[...new Set([...selection.excludedFileNames,...removed.map(file=>file.name)])].sort();
      db.prepare('UPDATE acquisition_torrent_selections SET excluded_json=? WHERE attempt_id=?').run(JSON.stringify(excluded),attemptId);
    }
    touchAttempt.run(nowMs,attemptId);
  }

  return {
    ...bonuses,
    ...selections,
    // A read-only preflight shortcut. An active claim blocks another release
    // for the same episode, but an unfinished claim for this exact candidate
    // must still reach the normal replay/reconciliation path.
    inspectCandidateTargets({ requestId, candidate, episodeIds } = {}) {
      if (!validId(requestId) || !validId(candidate?.indexerId) ||
          typeof candidate.guid !== 'string' || !candidate.guid ||
          candidate.guid.length > MAX_RELEASE_GUID_LENGTH ||
          !Array.isArray(episodeIds) || episodeIds.length < 1 ||
          episodeIds.length > MAX_ACQUISITION_TARGETS || episodeIds.some((id) => !validId(id)) ||
          new Set(episodeIds).size !== episodeIds.length) {
        throw new TypeError('Invalid candidate target inspection');
      }
      const request = requestRow.get(requestId);
      if (!request) return { state: 'unavailable' };
      const digest = digestForCandidate(candidate, request.anidb_id);
      const own = candidateRow.get(candidate.indexerId, digest);
      if (own && findRecovery.get(own.id)?.status === 'released') {
        return { state: 'skip_active' };
      }
      for (const id of episodeIds) {
        const active = busyTarget.get(request.anidb_id, id);
        if (active && (active.attempt_id !== own?.id ||
            own.request_id !== requestId || own.status === 'torrent_observed')) {
          return { state: 'skip_active' };
        }
      }
      return { state: 'eligible' };
    },
    // Read-only short circuit for a torrent this request already owns. A
    // matching claim can be reported busy without repeating the expensive
    // absence fence; it cannot authorize another dispatch or media action.
    getOwnedObservedCandidate({ requestId, candidate, episodeIds } = {}) {
      if (!validId(requestId) || !validId(candidate?.indexerId) ||
          typeof candidate.guid !== 'string' || !candidate.guid ||
          candidate.guid.length > MAX_RELEASE_GUID_LENGTH ||
          !Array.isArray(episodeIds) || episodeIds.length < 1 ||
          episodeIds.length > MAX_ACQUISITION_TARGETS || episodeIds.some((id) => !validId(id)) ||
          new Set(episodeIds).size !== episodeIds.length) {
        throw new TypeError('Invalid observed candidate lookup');
      }
      const request = requestRow.get(requestId);
      if (request?.status !== 'held' || episodeIds.some((id) =>
        !requestedEpisode.get(requestId, request.anidb_id, id))) return null;
      const digest = digestForCandidate(candidate, request.anidb_id);
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
    reserve({ requestId, candidate, episodeIds, preparedHash, plannedFiles, availableEpisodeIds = [],
      evidencePolicy = 'strict', nowMs, restricted }) {
      if (!validId(requestId) || !validTime(nowMs) ||
          !['strict', 'first_time_permissive'].includes(evidencePolicy) ||
          !validId(candidate?.indexerId) || typeof candidate.guid !== 'string' ||
          !candidate.guid || candidate.guid.length > MAX_RELEASE_GUID_LENGTH ||
          !Array.isArray(episodeIds) || episodeIds.length === 0 || episodeIds.length > MAX_ACQUISITION_TARGETS ||
          episodeIds.some((id) => !validId(id)) ||
          new Set(episodeIds).size !== episodeIds.length) {
        throw new TypeError('Invalid acquisition reservation');
      }
      return transact(() => {
        const request = requestRow.get(requestId);
        if (!request || request.status !== 'held') return held('request_missing');
        const accessHold = requestAccessHold(db, requestId, restricted);
        if (accessHold) return held(accessHold);
        const selectionReason = releaseReservationGate(db,requestId,candidate,episodeIds,nowMs,preparedHash,plannedFiles,availableEpisodeIds);
        if (selectionReason) return held(selectionReason);
        const digest = digestForCandidate(candidate, request.anidb_id);
        if (episodeIds.some((id) => !requestedEpisode.get(requestId, request.anidb_id, id))) {
          return held('target_not_requested');
        }
        const existing = candidateRow.get(candidate.indexerId, digest);
        if (existing && findRelease.get(existing.id)) return held('candidate_released');
        if (existing && findRejection.get(existing.id)) return held('candidate_rejected');
        if (existing && findRetirement.get(existing.id)) return held('candidate_retired');
        if (existing && findRecovery.get(existing.id)?.status === 'released') {
          return held('candidate_recovered');
        }
        if (existing && existing.request_id===requestId && existing.anidb_id===request.anidb_id &&
            existing.status==='reserved' && existing.evidence_policy===evidencePolicy && !findStart.get(existing.id) &&
            (existing.expected_hash===null || existing.expected_hash===preparedHash?.toLowerCase()) &&
            nowMs>=existing.updated_ms && Array.isArray(availableEpisodeIds) && Array.isArray(plannedFiles)) {
          const claimed=attemptEpisodes.all(existing.id).map(row=>row.episode_id);
          const removed=claimed.filter(id=>!episodeIds.includes(id));
          if (removed.length && removed.every(id=>availableEpisodeIds.includes(id)) && episodeIds.every(id=>claimed.includes(id))) {
            const fresh=canonicalFilePlan(plannedFiles);
            const previous=planRows.all(existing.id).map(item=>({name:item.file_name,size:item.file_size,episodeIds:JSON.parse(item.episode_key)}));
            const narrowed=previous.length?selectMissingFiles(previous,claimed,availableEpisodeIds):null;
            const selection=selections.getTorrentSelection(existing.id);
            if (JSON.stringify(fresh.targetIds)===JSON.stringify([...episodeIds].sort((a,b)=>a-b)) &&
                (!previous.length || narrowed.state==='missing_files' && JSON.stringify(narrowed.files)===JSON.stringify(fresh.files)) &&
                (!selection || selection.torrentHash===preparedHash?.toLowerCase() && fresh.files.every(file=>selection.files.some(item=>item.name===file.name && item.size===file.size)))) {
              saveNarrowedSelection(existing.id,previous,fresh.files,removed,nowMs,nowMs,selection);
            }
          }
        }
        if (existing) return existing.request_id === requestId && existing.anidb_id === request.anidb_id &&
          existing.evidence_policy === evidencePolicy &&
          JSON.stringify(attemptEpisodes.all(existing.id).map((row) => row.episode_id)) ===
          JSON.stringify([...episodeIds].sort((a, b) => a - b))
          ? { state: 'existing', attemptId: existing.id, status: existing.status }
          : held('candidate_claimed');
        if (episodeIds.some((id) => replacementAlreadyUsed.get(requestId,
          request.anidb_id, id))) return held('replacement_attempt_exhausted');
        if (evidencePolicy === 'first_time_permissive' &&
            episodeIds.some((id) => historicalTarget.get(request.anidb_id, id))) {
          return held('uncertain_attempt_exhausted');
        }
        if (episodeIds.some((id) => busyTarget.get(request.anidb_id, id))) return held('target_busy');
        const id = Number(insertAttempt.run(allocateDurableId(db, 'acquisition_attempts'), requestId, request.anidb_id, candidate.indexerId,
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
        bonuses.deactivateBonuses(attemptId,nowMs);
        return { state: 'released_pre_dispatch' };
      });
    },
    requestPrestartMismatchRetirement({ attemptId, hash, nowMs }) {
      if (!validId(attemptId) || !validHash(hash) || !validTime(nowMs)) {
        throw new TypeError('Invalid prestart mismatch retirement request');
      }
      return transact(() => {
        const row = findAttempt.get(attemptId);
        if (!row) return held('attempt_missing');
        const normalizedHash = hash.toLowerCase();
        if (row.expected_hash !== normalizedHash ||
            row.torrent_hash !== normalizedHash) return held('torrent_conflict');
        if (row.status !== 'torrent_observed' || findStart.get(attemptId) ||
            findRelease.get(attemptId) || findRejection.get(attemptId) ||
            findRetirement.get(attemptId) || nowMs < row.updated_ms ||
            (handoffTable.get() && db.prepare(
              'SELECT 1 FROM handoff_intents WHERE attempt_id=?').get(attemptId)) ||
            (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='completion_checks'").get() &&
              db.prepare('SELECT 1 FROM completion_checks WHERE attempt_id=?').get(attemptId))) {
          return held('prestart_state_changed');
        }
        const existing = findStallIntent.get(attemptId);
        if (existing) return existing.torrent_hash === normalizedHash
          ? { state: existing.status === 'requested'
            ? 'retirement_requested' : 'delete_unknown' }
          : held('torrent_conflict');
        if (!prestartRetirementBasis(attemptId)) return held('mismatch_not_recorded');
        insertStallIntent.run(attemptId, normalizedHash, nowMs, nowMs);
        return { state: 'retirement_requested' };
      });
    },
    beginPrestartMismatchDelete({ attemptId, hash, nowMs }) {
      if (!validId(attemptId) || !validHash(hash) || !validTime(nowMs)) {
        throw new TypeError('Invalid prestart mismatch delete intent');
      }
      return transact(() => {
        const row = findAttempt.get(attemptId);
        if (!row) return held('attempt_missing');
        const normalizedHash = hash.toLowerCase();
        if (row.expected_hash !== normalizedHash ||
            row.torrent_hash !== normalizedHash) return held('torrent_conflict');
        const intent = findStallIntent.get(attemptId);
        if (intent?.torrent_hash !== normalizedHash) {
          return held('retirement_not_requested');
        }
        if (row.status !== 'torrent_observed' || findStart.get(attemptId) ||
            findRetirement.get(attemptId) || nowMs < row.updated_ms ||
            nowMs < intent.updated_ms) return held('prestart_state_changed');
        if (intent.status === 'delete_unknown') {
          return { state: 'delete_unknown', sendNow: false };
        }
        return beginStallDelete.run(nowMs, attemptId, normalizedHash).changes === 1
          ? { state: 'delete_unknown', sendNow: true }
          : held('retirement_conflict');
      });
    },
    // An external coordinator must first prove the exact stopped torrent is
    // absent and its staging leaf empty. This only retires a previously saved
    // wrong-installment attempt that never crossed Negev's start boundary.
    retirePrestartMismatch({ attemptId, hash, nowMs }) {
      if (!validId(attemptId) || !validHash(hash) || !validTime(nowMs)) {
        throw new TypeError('Invalid prestart mismatch retirement');
      }
      return transact(() => {
        const row = findAttempt.get(attemptId);
        if (!row) return held('attempt_missing');
        const normalizedHash = hash.toLowerCase();
        if (row.expected_hash !== normalizedHash ||
            row.torrent_hash !== normalizedHash) return held('torrent_conflict');
        if (findPrestartMismatchRetirement.get(attemptId)) {
          return { state: 'retired_prestart_mismatch' };
        }
        if (row.status !== 'torrent_observed' || findStart.get(attemptId) ||
            findRelease.get(attemptId) || findRejection.get(attemptId) ||
            findRetirement.get(attemptId) ||
            (handoffTable.get() && db.prepare(
              'SELECT 1 FROM handoff_intents WHERE attempt_id=?').get(attemptId)) ||
            (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='completion_checks'").get() &&
              db.prepare('SELECT 1 FROM completion_checks WHERE attempt_id=?').get(attemptId))) {
          return held('prestart_state_changed');
        }
        const basis = prestartRetirementBasis(attemptId);
        if (!basis) return held('mismatch_not_recorded');
        const intent = findStallIntent.get(attemptId);
        if (intent?.torrent_hash !== normalizedHash ||
            intent.status !== 'delete_unknown') {
          return held('retirement_not_requested');
        }
        if (nowMs < row.updated_ms) return held('time_before_last_transition');
        // An admin release says nothing about the file's identity: retire it
        // as a policy reset so the same release can be chosen again later.
        insertRetirement.run(attemptId, normalizedHash,
          basis === 'operator_release' ? 'policy_reset' : 'file_wrong_identity', nowMs);
        insertPrestartMismatchRetirement.run(attemptId, nowMs);
        deactivateClaims.run(attemptId);
        bonuses.deactivateBonuses(attemptId,nowMs);
        touchAttempt.run(nowMs, attemptId);
        return { state: 'retired_prestart_mismatch' };
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
        bonuses.deactivateBonuses(attemptId,nowMs);
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
        bonuses.deactivateBonuses(attemptId,nowMs);
        touchAttempt.run(nowMs, attemptId);
        return { state: 'retired_stalled' };
      });
    },
    requestMediaRetirement({ attemptId, hash, reason, nowMs }) {
      if (!validId(attemptId) || !validHash(hash) || !validTime(nowMs) ||
          !['japanese_audio_missing','english_full_subtitles_missing',
            'outside_quality_profile','audio_language_unverified',
            'resolution_unavailable','media_tracks_unverified'].includes(reason)) {
        throw new TypeError('Invalid media retirement request');
      }
      return transact(() => {
        const row = findAttempt.get(attemptId);
        if (!row) return held('attempt_missing');
        const normalizedHash = hash.toLowerCase();
        if (row.expected_hash !== normalizedHash ||
            row.torrent_hash !== normalizedHash) return held('torrent_conflict');
        const existing = findMediaIntent.get(attemptId);
        if (existing) return existing.torrent_hash === normalizedHash &&
          existing.reason === reason
          ? { state: existing.status === 'requested'
            ? 'retirement_requested' : 'delete_unknown' }
          : held('retirement_conflict');
        if (row.status !== 'torrent_observed' ||
            findStart.get(attemptId)?.torrent_hash !== normalizedHash ||
            findRelease.get(attemptId) || findRejection.get(attemptId) ||
            findRetirement.get(attemptId) || findStallIntent.get(attemptId) ||
            nowMs < row.updated_ms) return held('retirement_conflict');
        if (handoffTable.get() && db.prepare(
          'SELECT 1 FROM handoff_intents WHERE attempt_id=?').get(attemptId)) {
          return held('handoff_already_recorded');
        }
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pure_move_intents'").get() &&
            db.prepare('SELECT 1 FROM pure_move_intents WHERE attempt_id=?').get(attemptId)) {
          return held('handoff_already_recorded');
        }
        insertMediaIntent.run(attemptId, normalizedHash, reason, nowMs, nowMs);
        return { state: 'retirement_requested' };
      });
    },
    getMediaRetirementIntent(attemptId) {
      if (!validId(attemptId)) throw new TypeError('Invalid attempt ID');
      const row = findMediaIntent.get(attemptId);
      return row ? { hash: row.torrent_hash, reason: row.reason,
        status: row.status } : null;
    },
    beginMediaDelete({ attemptId, hash, nowMs }) {
      if (!validId(attemptId) || !validHash(hash) || !validTime(nowMs)) {
        throw new TypeError('Invalid media delete intent');
      }
      return transact(() => {
        const row = findMediaIntent.get(attemptId);
        const normalizedHash = hash.toLowerCase();
        if (!row) return held('retirement_not_requested');
        if (row.torrent_hash !== normalizedHash) return held('torrent_conflict');
        if (findRetirement.get(attemptId)) return held('already_retired');
        if (row.status === 'delete_unknown') {
          return { state: 'delete_unknown', sendNow: false };
        }
        if (nowMs < row.updated_ms) return held('time_before_last_transition');
        return beginMediaDelete.run(nowMs, attemptId, normalizedHash).changes === 1
          ? { state: 'delete_unknown', sendNow: true }
          : held('retirement_conflict');
      });
    },
    // Only an explicit authenticated HTTP 403 response proves the delete was
    // rejected rather than timing out. The caller may then renew and retry.
    resetMediaDeleteAfterRejection({ attemptId, hash, nowMs }) {
      if (!validId(attemptId) || !validHash(hash) || !validTime(nowMs)) {
        throw new TypeError('Invalid media delete rejection');
      }
      return transact(() => {
        const normalizedHash = hash.toLowerCase();
        const intent = findMediaIntent.get(attemptId);
        if (intent?.torrent_hash !== normalizedHash ||
            intent.status !== 'delete_unknown' ||
            findRetirement.get(attemptId) || nowMs < intent.updated_ms) {
          return held('retirement_conflict');
        }
        return resetRejectedMediaDelete.run(nowMs, attemptId,
          normalizedHash).changes === 1
          ? { state: 'retirement_requested' } : held('retirement_conflict');
      });
    },
    retireMedia({ attemptId, hash, nowMs }) {
      if (!validId(attemptId) || !validHash(hash) || !validTime(nowMs)) {
        throw new TypeError('Invalid media retirement');
      }
      return transact(() => {
        const row = findAttempt.get(attemptId);
        if (!row) return held('attempt_missing');
        const normalizedHash = hash.toLowerCase();
        if (row.expected_hash !== normalizedHash ||
            row.torrent_hash !== normalizedHash) return held('torrent_conflict');
        const existing = findRetirement.get(attemptId);
        if (existing) return existing.torrent_hash === normalizedHash &&
          existing.reason === 'media_tracks_unsuitable'
          ? { state: 'retired_media' } : held('retirement_conflict');
        const intent = findMediaIntent.get(attemptId);
        if (!intent || intent.torrent_hash !== normalizedHash) {
          return held('retirement_not_requested');
        }
        if (intent.status !== 'delete_unknown') return held('delete_intent_missing');
        if (row.status !== 'torrent_observed' ||
            findStart.get(attemptId)?.torrent_hash !== normalizedHash ||
            findRelease.get(attemptId) || findRejection.get(attemptId) ||
            nowMs < row.updated_ms || nowMs < intent.updated_ms) {
          return held('retirement_conflict');
        }
        if (handoffTable.get() && db.prepare(
          'SELECT 1 FROM handoff_intents WHERE attempt_id=?').get(attemptId)) {
          return held('handoff_already_recorded');
        }
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pure_move_intents'").get() &&
            db.prepare('SELECT 1 FROM pure_move_intents WHERE attempt_id=?').get(attemptId)) {
          return held('handoff_already_recorded');
        }
        insertRetirement.run(attemptId, normalizedHash,
          'media_tracks_unsuitable', nowMs);
        deactivateClaims.run(attemptId);
        bonuses.deactivateBonuses(attemptId,nowMs);
        touchAttempt.run(nowMs, attemptId);
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='acquisition_request_checks'").get()) {
          db.prepare(`UPDATE acquisition_request_checks SET state='held',
            reason='reconciled_observed_attempts',attempt_id=NULL,
            next_due_ms=?,candidate_offset=0,candidate_fingerprint=NULL
            WHERE request_id=? AND state IS NOT NULL`)
            .run(nowMs, row.request_id);
        }
        return { state: 'retired_media' };
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
        const digest = digestForCandidate(candidate, row.anidb_id);
        if (row.indexer_id !== candidate.indexerId || row.candidate_digest !== digest) {
          return held('candidate_mismatch');
        }
        const normalizedHash = hash.toLowerCase();
        if (row.expected_hash && row.expected_hash !== normalizedHash) return held('torrent_conflict');
        if (busyHash.get(normalizedHash, attemptId, row.anidb_id)) return held('torrent_claimed');
        if (row.status === 'reserved' && !row.expected_hash) {
          prepare.run(normalizedHash, nowMs, attemptId);
          return { state: 'prepared', expectedHash: normalizedHash };
        }
        if (row.status === 'reserved') return { state: 'prepared', expectedHash: normalizedHash };
        return { state: row.status, expectedHash: normalizedHash };
      });
    },
    reviseUnstartedSelection({ attemptId, hash, expectedPlan, availableEpisodeIds, checkedMs, nowMs, restricted }) {
      if (!validId(attemptId) || !validHash(hash) || !validTime(nowMs) || !validTime(checkedMs) ||
          !Array.isArray(availableEpisodeIds) || availableEpisodeIds.some(id=>!validId(id)) ||
          new Set(availableEpisodeIds).size!==availableEpisodeIds.length) throw new TypeError('Invalid selection revision');
      const expected = canonicalFilePlan(expectedPlan);
      return transact(() => {
        const row=findAttempt.get(attemptId);
        if (!row || row.status!=='torrent_observed' || row.torrent_hash!==hash.toLowerCase() ||
            findStart.get(attemptId) || findRelease.get(attemptId) || findRejection.get(attemptId) ||
            findRetirement.get(attemptId) || findStallIntent.get(attemptId)) return held('selection_not_revisable');
        if (nowMs<row.updated_ms || nowMs<checkedMs || nowMs-checkedMs>30_000) return held('availability_evidence_stale');
        const request=requestRow.get(row.request_id);
        if (!request || request.status!=='held') return held('request_missing');
        const accessHold=requestAccessHold(db,row.request_id,restricted);
        if (accessHold) return held(accessHold);
        const ids=attemptEpisodes.all(attemptId).map(item=>item.episode_id);
        const stored=planRows.all(attemptId).map(item=>({name:item.file_name,size:item.file_size,episodeIds:JSON.parse(item.episode_key)}));
        if (JSON.stringify(stored)!==JSON.stringify(expected.files) ||
            JSON.stringify(ids)!==JSON.stringify(expected.targetIds) ||
            availableEpisodeIds.some(id=>!ids.includes(id))) return held('file_plan_changed');
        const remaining=selectMissingFiles(stored,ids,availableEpisodeIds);
        if (remaining.state!=='missing_files') return remaining;
        if (!remaining.excludedFiles.length) return held('file_plan_unchanged');
        const selection=selections.getTorrentSelection(attemptId);
        if (!selection || selection.torrentHash!==hash.toLowerCase() || stored.some(file=>
            !selection.files.some(item=>item.name===file.name && item.size===file.size))) return held('torrent_selection_conflict');
        saveNarrowedSelection(attemptId,stored,remaining.files,remaining.excludedEpisodeIds,checkedMs,nowMs,selection);
        return {state:'selection_revised'};
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
    beginDispatch({ attemptId, nowMs, restricted }) {
      if (!validId(attemptId) || !validTime(nowMs)) throw new TypeError('Invalid dispatch intent');
      return transact(() => {
        const row = findAttempt.get(attemptId);
        if (!row) return held('attempt_missing');
        if (findRelease.get(attemptId)) return held('candidate_released');
        if (findRejection.get(attemptId)) return held('candidate_rejected');
        if (nowMs < row.updated_ms) return held('time_before_last_transition');
        if (row.status === 'reserved' && !row.expected_hash) return held('torrent_not_prepared');
        if (row.status === 'reserved') {
          const accessHold = requestAccessHold(db, row.request_id, restricted);
          if (accessHold) return held(accessHold);
          begin.run(nowMs, attemptId);
          return { state: 'dispatch_unknown', sendNow: true };
        }
        return { state: row.status, sendNow: false };
      });
    },
    rejectDispatch({attemptId,candidate,hash,nowMs,httpStatus}={}) {
      if(!validId(attemptId)||!validId(candidate?.indexerId)||typeof candidate?.guid!=='string'||!candidate.guid||
        candidate.guid.length>MAX_RELEASE_GUID_LENGTH||!validHash(hash)||!validTime(nowMs)||httpStatus!==403)throw new TypeError('Invalid definitive dispatch refusal');
      return transact(()=>{
        const row=findAttempt.get(attemptId),prior=findDispatchRefusal.get(attemptId);
        const base=createHash('sha256').update(canonicalReleaseGuid(candidate.guid,candidate.indexerId)).digest('hex');
        if(prior) {
          if(prior.indexer_id!==candidate.indexerId||prior.candidate_base!==base)return held('candidate_conflict');
          return prior.torrent_hash===hash.toLowerCase()?{state:'dispatch_rejected'}:held('torrent_conflict');
        }
        if(!row||row.indexer_id!==candidate.indexerId||row.candidate_digest!==digestForCandidate(candidate,row.anidb_id))return held('candidate_conflict');
        if(row.status!=='dispatch_unknown'||row.torrent_hash!==null||row.expected_hash!==hash.toLowerCase()||findStart.get(attemptId)||findRelease.get(attemptId)||findRejection.get(attemptId))return held('dispatch_not_rejectable');
        if(nowMs<row.updated_ms)return held('time_before_last_transition');
        db.prepare('INSERT INTO acquisition_dispatch_refusals VALUES(?,?,?,?,?,?,403)').run(attemptId,row.anidb_id,row.indexer_id,base,hash.toLowerCase(),nowMs);
        insertRelease.run(attemptId,nowMs);deactivateClaims.run(attemptId);bonuses.deactivateBonuses(attemptId,nowMs);
        return {state:'dispatch_rejected'};
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
    beginStart({ attemptId, hash, manifestDigest, nowMs, sendToken = null, restricted }) {
      if (!validId(attemptId) || typeof hash !== 'string' ||
          !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(hash) ||
          typeof manifestDigest !== 'string' || !/^[0-9a-f]{64}$/i.test(manifestDigest) ||
          !validTime(nowMs)) throw new TypeError('Invalid start intent');
      if(sendToken!==null && (typeof sendToken!=='string'|| !/^[a-f0-9-]{36}$/.test(sendToken))) throw new TypeError('Invalid start token');
      return transact(() => {
        const row = findAttempt.get(attemptId);
        if (!row) return held('attempt_missing');
        if (findRelease.get(attemptId)) return held('candidate_released');
        if (findRejection.get(attemptId)) return held('candidate_rejected');
        if (findStallIntent.get(attemptId)) return held('retirement_requested');
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
        const accessHold = requestAccessHold(db, row.request_id, restricted);
          if (accessHold) return held(accessHold);
        insertStart.run(attemptId, normalizedHash, normalizedDigest, nowMs, nowMs);
        db.prepare('UPDATE acquisition_starts SET send_token=? WHERE attempt_id=?').run(sendToken,attemptId);
        return { state: 'start_unknown', sendNow: true };
      });
    },
    rejectStart({attemptId, hash, manifestDigest, sendToken, nowMs}) {
      if(!validId(attemptId)||!validTime(nowMs)||typeof sendToken!=='string'||!/^[a-f0-9-]{36}$/.test(sendToken)) throw new TypeError('Invalid start rejection');
      return transact(()=>{
        const row=db.prepare("SELECT * FROM acquisition_starts WHERE attempt_id=? AND status='start_unknown' AND send_token=? AND torrent_hash=? AND manifest_digest=?").get(attemptId,sendToken,hash,manifestDigest);
        if(!row||nowMs<row.updated_ms)return held('start_intent_changed');
        db.prepare('INSERT INTO acquisition_start_rejections(send_token,attempt_id,torrent_hash,manifest_digest,rejected_ms,http_status) VALUES(?,?,?,?,?,403)').run(sendToken,attemptId,hash,manifestDigest,nowMs);
        db.prepare('DELETE FROM acquisition_starts WHERE attempt_id=? AND send_token=?').run(attemptId,sendToken);
        return {state:'start_rejected'};
      });
    },
    findPreviouslyVerifiedFile({ anidbId, torrentHash, file } = {}) {
      if (!validId(anidbId) || !validHash(torrentHash)) return null;
      let plan;
      try { plan = canonicalFilePlan([file]).files[0]; } catch { return null; }
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='file_availability_proofs'").get()) {
        return null;
      }
      // A filename, current availability, or another torrent's proof alone is
      // insufficient. All targets must have been proved against this one file.
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pure_move_intents'").get()) {
        return null;
      }
      const rows = db.prepare(`SELECT p.file_id AS fileId,f.file_size AS size,
          m.manifest_json AS manifestJson
        FROM acquisition_attempts a
        JOIN pure_move_intents m ON m.attempt_id=a.id AND m.torrent_hash=a.torrent_hash
          AND m.status IN ('published_observed','publish_unknown')
        JOIN acquisition_file_plans f ON f.attempt_id=a.id
        JOIN file_availability_proofs p ON p.anidb_id=a.anidb_id
          AND p.episode_id IN (SELECT value FROM json_each(f.episode_key))
        WHERE a.anidb_id=? AND a.torrent_hash=? AND f.file_name=?
          AND f.file_size=? AND f.episode_key=? AND p.presentation='exact'
        GROUP BY p.file_id,f.file_size,m.manifest_json
        HAVING COUNT(DISTINCT p.episode_id)=? LIMIT 2`)
        .all(anidbId, torrentHash.toLowerCase(), plan.name, plan.size,
          JSON.stringify(plan.episodeIds), plan.episodeIds.length);
      if (rows.length !== 1) return null;
      try {
        const manifest = JSON.parse(rows[0].manifestJson);
        const physical = manifest.torrentHash === torrentHash.toLowerCase() &&
          manifest.files.find((item) => item.name === plan.name && item.size === plan.size &&
            JSON.stringify([...item.episodeIds].sort((a, b) => a - b)) ===
              JSON.stringify(plan.episodeIds));
        if (!physical || ['dev', 'ino', 'mtimeNs'].some((key) =>
          typeof physical[key] !== 'string' || !/^\d+$/.test(physical[key]))) return null;
        return { fileId: rows[0].fileId, size: rows[0].size, physical: {
          dev: physical.dev, ino: physical.ino, mtimeNs: physical.mtimeNs } };
      } catch { return null; }
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
        status: findDispatchRefusal.get(attemptId) ? 'dispatch_rejected' : findRelease.get(attemptId) ? 'released_pre_dispatch' :
          findPrestartMismatchRetirement.get(attemptId)
            ? 'retired_prestart_mismatch' :
          findRetirement.get(attemptId)?.reason === 'stalled_download'
            ? 'retired_stalled' :
          findRetirement.get(attemptId)?.reason === 'media_tracks_unsuitable'
            ? 'retired_media' :
            findRetirement.get(attemptId) ? 'retired_rejected' :
            rejection ? 'rejected_held' : row.status,
        expectedHash: row.expected_hash, torrentHash: row.torrent_hash,
        ...(rejection ? { rejectionReason: rejection.reason } : {}) } : null;
    },
    close() { db.close(); },
  };
}
