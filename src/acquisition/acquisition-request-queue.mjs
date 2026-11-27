import { pendingRecognitionSql, unreconciledAttemptSql } from './recognition-release-sql.mjs';
import { activeRequestOwnerSql } from './request-owner.mjs';
import { DatabaseSync } from 'node:sqlite';
import { REQUEST_RELATED_RETRY_HOLDS, REQUEST_SESSION_RETRY_HOLDS }
  from './stage-hold-policy.mjs';
import { createHash } from 'node:crypto';
import { preferredWaitDuration } from './preferred-release.mjs';
import { changedRequestScopeSql, currentRequestCompletionSql, currentRequestScopeSql, untouchedAutoSql } from '../requests/request-check-scope.mjs';

import { heldReporter } from '../runtime/held-diagnostics.mjs';
const validId = (value) => Number.isSafeInteger(value) && value > 0;
const validTime = (value) => Number.isSafeInteger(value) && value >= 0;
const held = (reason) => ({ state: 'held', reason });
const heldAfter = heldReporter('acquisition/acquisition-request-queue');
const RETRY_DELAY_MS = 30 * 60_000;
const SESSION_RETRY_MS = 60_000;
const COVERAGE_CONTINUATION_MS = 1_000;
const RELATED_RETRY_MS = 5 * 60_000;
const METADATA_SHORT_RETRY_MS = 60_000;
const METADATA_SHORT_WINDOW_MS = 10 * 60_000;
const validCandidateFingerprint = (value) => {
  if (typeof value !== 'string' || value.length > 3_400) return false;
  const parts = value.split(':');
  if (parts.length < 1 || parts.length > 2 ||
      !/^[0-9a-f]{64}$/.test(parts[0])) return false;
  if (parts.length === 1) return true;
  const groups = parts[1].split('|');
  if (groups.length < 1 || groups.length > 2 || groups.some((group) =>
    !/^(?:[0-9a-f]{64}(?:,[0-9a-f]{64})*)?$/.test(group))) return false;
  const ids = groups.flatMap((group) => group ? group.split(',') : []);
  return ids.length > 0 && ids.length <= 50 &&
    new Set(ids).size === ids.length;
};

// A closed watch can still have requested episodes missing. A settled miss
// requires a retry even after the disposable negative memo has expired. Repair
// only this unscheduled state; never reopen a completed watch or active claim.
// The normal worker must re-read availability, choices and ownership afterward.
const repairUnscheduledClosedMisses = (db, requestId = null) => db.prepare(`
  UPDATE acquisition_request_checks SET next_due_ms=checked_ms+60000
  WHERE (? IS NULL OR request_id=?) AND state='held'
    AND reason='no_safe_release' AND checked_ms IS NOT NULL
    AND next_due_ms IS NULL AND request_id IN (
      SELECT r.id FROM requests r WHERE r.status='held'
        AND r.watch_closed=1 AND r.cancelled_ms IS NULL
        AND NOT EXISTS (SELECT 1 FROM acquisition_request_suspensions s
          WHERE s.request_id=r.id)
        AND EXISTS (SELECT 1 FROM request_targets rt WHERE rt.request_id=r.id)
        AND NOT EXISTS (SELECT 1 FROM request_targets rt
          LEFT JOIN targets t ON t.id=rt.target_id
          WHERE rt.request_id=r.id AND (t.id IS NULL OR t.anidb_id<>r.anidb_id))
    )`).run(requestId, requestId);

// This queue only chooses which saved request to examine. It never searches
// an indexer, calls qBittorrent, or treats a held item as completed.
export function openAcquisitionRequestQueue(dbPath,
  { allowedAnidbIds = null, ownershipGate = null } = {}) {
  if (typeof dbPath !== 'string' || !dbPath || dbPath === ':memory:') {
    throw new TypeError('Durable acquisition queue path required');
  }
  if (allowedAnidbIds !== null &&
      (!Array.isArray(allowedAnidbIds) || allowedAnidbIds.length < 1 ||
       allowedAnidbIds.length > 100 ||
       allowedAnidbIds.some((id) => !validId(id)) ||
       new Set(allowedAnidbIds).size !== allowedAnidbIds.length)) {
    throw new TypeError('Invalid acquisition title cohort');
  }
  if (ownershipGate !== null && typeof ownershipGate?.status !== 'function') {
    throw new TypeError('Invalid acquisition ownership gate');
  }
  const db = new DatabaseSync(dbPath, { timeout: 5_000 });
  // A disabled account's requests wait: nothing new is searched or started
  // for them until an admin enables the account again. Work already past
  // this queue (a started download) finishes normally.
  const cohortFilter = `${activeRequestOwnerSql(db, 'r.id')} AND ` +
    (allowedAnidbIds === null ? '' :
      `r.anidb_id IN (${allowedAnidbIds.map(() => '?').join(',')}) AND`);
  try {
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA foreign_keys=ON');
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='requests'").get()) {
      throw new TypeError('Request ledger must be initialized first');
    }
    db.exec(`CREATE TABLE IF NOT EXISTS acquisition_request_cursor (
      id INTEGER PRIMARY KEY CHECK(id=1),
      after_id INTEGER NOT NULL CHECK(after_id>=0),
      pass INTEGER NOT NULL CHECK(pass>0)
    ) STRICT`);
    db.exec(`CREATE TABLE IF NOT EXISTS acquisition_request_checks (
      request_id INTEGER PRIMARY KEY REFERENCES requests(id),
      pass INTEGER NOT NULL CHECK(pass>0),
      state TEXT CHECK(state IN ('held','stopped_observed')),
      reason TEXT,
      attempt_id INTEGER CHECK(attempt_id>0),
      checked_ms INTEGER CHECK(checked_ms>=0),
      next_due_ms INTEGER CHECK(next_due_ms>=0),
      empty_since_ms INTEGER CHECK(empty_since_ms>=0),
      metadata_since_ms INTEGER CHECK(metadata_since_ms>=0),
      scan_started_ms INTEGER CHECK(scan_started_ms>=0),
      candidate_offset INTEGER NOT NULL DEFAULT 0 CHECK(candidate_offset BETWEEN 0 AND 50),
      candidate_fingerprint TEXT,
      search_policy_rechecked INTEGER NOT NULL DEFAULT 0
        CHECK(search_policy_rechecked IN (0,1,2))
    ) STRICT`);
    if (!db.prepare('PRAGMA table_info(acquisition_request_checks)').all()
      .some(column => column.name === 'checked_release_revision')) {
      // Missing historical provenance is unknown, not a saved revision zero.
      // One atomic schema change also preserves this across interrupted upgrade.
      // New worker claims explicitly write their actual current revision.
      db.exec('ALTER TABLE acquisition_request_checks ADD COLUMN checked_release_revision INTEGER NOT NULL DEFAULT -1');
    }
    // Migration review can hold an unstarted request without cancelling the
    // user's request or changing an existing download. The row survives a
    // restart and new requests remain eligible by default.
    db.exec(`CREATE TABLE IF NOT EXISTS acquisition_request_suspensions (
      request_id INTEGER PRIMARY KEY REFERENCES requests(id),
      reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 80),
      recorded_ms INTEGER NOT NULL CHECK(recorded_ms>=0)
    ) STRICT`);
    if (!db.prepare('PRAGMA table_info(acquisition_request_checks)').all()
      .some((column) => column.name === 'candidate_offset')) {
      db.exec(`ALTER TABLE acquisition_request_checks ADD COLUMN candidate_offset
        INTEGER NOT NULL DEFAULT 0 CHECK(candidate_offset BETWEEN 0 AND 50)`);
    }
    if (!db.prepare('PRAGMA table_info(acquisition_request_checks)').all()
      .some((column) => column.name === 'candidate_fingerprint')) {
      db.exec('ALTER TABLE acquisition_request_checks ADD COLUMN candidate_fingerprint TEXT');
    }
    if (!db.prepare('PRAGMA table_info(acquisition_request_checks)').all()
      .some((column) => column.name === 'empty_since_ms')) {
      db.exec('ALTER TABLE acquisition_request_checks ADD COLUMN empty_since_ms INTEGER CHECK(empty_since_ms>=0)');
    }
    if (!db.prepare('PRAGMA table_info(acquisition_request_checks)').all()
      .some((column) => column.name === 'metadata_since_ms')) {
      db.exec('ALTER TABLE acquisition_request_checks ADD COLUMN metadata_since_ms INTEGER CHECK(metadata_since_ms>=0)');
    }
    if (!db.prepare('PRAGMA table_info(acquisition_request_checks)').all()
      .some((column) => column.name === 'scan_started_ms')) {
      db.exec('ALTER TABLE acquisition_request_checks ADD COLUMN scan_started_ms INTEGER CHECK(scan_started_ms>=0)');
    }
    if (!db.prepare('PRAGMA table_info(acquisition_request_checks)').all()
      .some((column) => column.name === 'search_policy_rechecked')) {
      db.exec(`ALTER TABLE acquisition_request_checks ADD COLUMN
        search_policy_rechecked INTEGER NOT NULL DEFAULT 0
        CHECK(search_policy_rechecked IN (0,1,2))`);
    }
    for (const [column, type] of [['scan_scope', 'TEXT'], ['decision_ms', 'INTEGER'], ['scan_target_count', 'INTEGER']]) {
      if (!db.prepare('PRAGMA table_info(acquisition_request_checks)').all()
        .some(item => item.name === column)) {
        db.exec(`ALTER TABLE acquisition_request_checks ADD COLUMN ${column} ${type}`);
      }
    }
    // A completion applies only to the targets actually admitted for its
    // check. Restore old exact snapshots only when the existing hash proves
    // the same scope; unknown/stale completion gets a normal fresh check.
    if (!db.prepare('PRAGMA table_info(acquisition_request_checks)').all()
      .some(column => column.name === 'scan_targets_json')) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec('ALTER TABLE acquisition_request_checks ADD COLUMN scan_targets_json TEXT');
        const oldScopes = db.prepare(`SELECT request_id,scan_scope
          FROM acquisition_request_checks WHERE scan_scope IS NOT NULL`).all();
        const targets = db.prepare(`SELECT t.anidb_id,t.episode_id FROM targets t
          JOIN request_targets rt ON rt.target_id=t.id WHERE rt.request_id=?
          ORDER BY t.episode_id,t.anidb_id`);
        const restore = db.prepare(`UPDATE acquisition_request_checks SET scan_targets_json=?
          WHERE request_id=?`);
        for (const row of oldScopes) {
          const scope = targets.all(row.request_id);
          if (createHash('sha256').update(JSON.stringify(scope)).digest('hex') === row.scan_scope) {
            restore.run(JSON.stringify(scope.map(t => [t.anidb_id,t.episode_id])), row.request_id);
          }
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    db.exec(`UPDATE acquisition_request_checks SET
      next_due_ms=MIN(COALESCE(next_due_ms,checked_ms+60000),checked_ms+60000)
      WHERE state='held' AND reason IN ('metadata_reader_busy',
        'provider_unavailable','release_preflight_unavailable',
        'availability_evidence_stale','import_activity_unverified') AND checked_ms IS NOT NULL
        AND (next_due_ms IS NULL OR next_due_ms>checked_ms+60000)`);
    // Revisit legacy typed-target and transient-alias misses once. Preserve
    // elapsed work, claims and suspensions; fresh misses keep normal cadence.
    if (!db.prepare('PRAGMA table_info(acquisition_request_checks)').all()
      .some(column => column.name === 'discovery_policy_revision')) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(`ALTER TABLE acquisition_request_checks ADD COLUMN
          discovery_policy_revision INTEGER NOT NULL DEFAULT 1 CHECK(discovery_policy_revision=1);
          UPDATE acquisition_request_checks SET
            next_due_ms=MIN(COALESCE(next_due_ms,checked_ms+60000),checked_ms+60000)
          WHERE state='held' AND reason IN ('invalid_request','release_title_mismatch','no_safe_release')
            AND checked_ms IS NOT NULL AND request_id IN
              (SELECT id FROM requests WHERE cancelled_ms IS NULL)`);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    // Revisit one recent multi-episode Airing miss under the broader episode
    // query once. A settled empty watch retains its normal hourly cadence.
    const policyNowMs = Date.now();
    db.prepare(`UPDATE acquisition_request_checks SET
      next_due_ms=MIN(next_due_ms,?),search_policy_rechecked=1
      WHERE state='held' AND reason='no_safe_release'
        AND search_policy_rechecked=0 AND checked_ms>=?
        AND request_id IN (SELECT request_id FROM request_targets
          GROUP BY request_id HAVING COUNT(*) BETWEEN 2 AND 10)`)
      .run(policyNowMs + 60_000, policyNowMs - 2 * 3_600_000);
    // Older releases imposed a 15-minute idle delay after a candidate scan
    // timed out. Keep its saved cursor and make the unfinished sweep eligible
    // on the normal short retry instead of waiting for that artificial pause.
    db.exec(`UPDATE acquisition_request_checks
      SET next_due_ms=MIN(next_due_ms,checked_ms+60000)
      WHERE state='held' AND reason='candidate_scan_time_budget'
        AND checked_ms IS NOT NULL AND next_due_ms>checked_ms+60000`);
    // A momentary relation-provider miss used to take the generic 30-minute
    // backoff before any candidate could be inspected. Keep the relation
    // guard and bound that lookup retry, including rows saved by old builds.
    db.exec(`UPDATE acquisition_request_checks
      SET next_due_ms=MIN(next_due_ms,checked_ms+300000)
      WHERE state='held' AND reason='related_title_unavailable'
        AND checked_ms IS NOT NULL AND next_due_ms>checked_ms+300000`);
    // Keep the Import safety observation intact, but bring older transient
    // holds forward when a release first adopts the shorter retry.
    db.exec(`UPDATE acquisition_request_checks
      SET next_due_ms=MIN(next_due_ms,checked_ms+60000)
      WHERE state='held' AND reason='import_quiet_window_unverified'
        AND checked_ms IS NOT NULL AND next_due_ms>checked_ms+60000`);
    // A hash already held by another qBittorrent owner is a candidate-level
    // collision. Older builds saved a 30-minute request hold for this case.
    db.exec(`UPDATE acquisition_request_checks
      SET next_due_ms=MIN(next_due_ms,checked_ms+60000)
      WHERE state='held' AND reason='torrent_hash_in_use'
        AND checked_ms IS NOT NULL AND next_due_ms>checked_ms+60000`);
    db.exec(`UPDATE acquisition_request_checks
      SET next_due_ms=MIN(next_due_ms,checked_ms+60000)
      WHERE state='held' AND reason='service_stopping'
        AND checked_ms IS NOT NULL AND next_due_ms>checked_ms+60000`);
    if (!db.prepare('PRAGMA table_info(acquisition_request_checks)').all().some(c=>c.name==='coverage_policy_revision')) {
      db.exec('ALTER TABLE acquisition_request_checks ADD COLUMN coverage_policy_revision INTEGER NOT NULL DEFAULT 0 CHECK(coverage_policy_revision>=0)');
    }
    // Old generic holds also contained budget-deferred positive checks. Bring
    // these forward once; the worker now distinguishes a continuation from
    // genuine uncertainty and never grants permission to duplicate owned media.
    db.exec(`UPDATE acquisition_request_checks
      SET next_due_ms=MIN(next_due_ms,checked_ms+60000)
      WHERE state='held' AND reason='availability_unverified' AND coverage_policy_revision=0
        AND checked_ms IS NOT NULL AND next_due_ms>checked_ms+60000;
      UPDATE acquisition_request_checks SET coverage_policy_revision=1 WHERE coverage_policy_revision=0`);
    if (!db.prepare('PRAGMA table_info(acquisition_request_checks)').all()
      .some(column => column.name === 'request_scope_policy_revision')) {
      db.exec(`ALTER TABLE acquisition_request_checks ADD COLUMN
        request_scope_policy_revision INTEGER NOT NULL DEFAULT 0
        CHECK(request_scope_policy_revision>=0)`);
    }
    // Revision 1 was stamped by migration even when a legacy worker had
    // checked only a selected subset. A later member choice may have erased
    // that subset, so matching claim scope alone cannot prove full coverage.
    // Preserve an exact unchanged completion with positive untouched-Auto
    // provenance. Other old multi-target completion needs one normal recheck;
    // only a new full-scope worker claim earns revision 2.
    db.exec(`UPDATE acquisition_request_checks AS c SET
        reason='request_scope_recheck',next_due_ms=0,candidate_offset=0,
        candidate_fingerprint=NULL,decision_ms=NULL,scan_started_ms=NULL,
        scan_scope=NULL,scan_target_count=NULL,scan_targets_json=NULL
      WHERE request_scope_policy_revision<2 AND state='held'
        AND reason='request_fully_available' AND request_id IN (
          SELECT r.id FROM requests r WHERE r.status='held' AND r.cancelled_ms IS NULL
            AND (SELECT COUNT(*) FROM request_targets rt WHERE rt.request_id=r.id)>1
            AND NOT (${untouchedAutoSql} AND c.scan_targets_json IS NOT NULL
              AND c.scan_targets_json=${currentRequestScopeSql}))`);
    // Corrected verification must reach old settled misses before their hourly
    // retry. Revisit only saved candidate evidence for the same target scope;
    // this changes scheduling, never acquisition eligibility or a choice.
    // Revision 1 skipped closed watches even when requested episodes were
    // still missing. Revision 2 recovers those exact old-evidence holds once;
    // closure still prevents future episode discovery, and completed watches,
    // suspensions and active claims retain their existing state.
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!db.prepare('PRAGMA table_info(acquisition_request_checks)').all()
        .some(column => column.name === 'verification_policy_revision')) {
        db.exec(`ALTER TABLE acquisition_request_checks ADD COLUMN
          verification_policy_revision INTEGER NOT NULL DEFAULT 0 CHECK(verification_policy_revision>=0)`);
      }
      const legacyMisses = db.prepare(`SELECT c.request_id AS requestId,
          r.anidb_id AS anidbId,c.candidate_fingerprint AS fingerprint
        FROM acquisition_request_checks c JOIN requests r ON r.id=c.request_id
        WHERE (c.verification_policy_revision=0 AND r.watch_closed=0 OR
            c.verification_policy_revision<2 AND r.watch_closed=1) AND c.state='held'
          AND c.reason='no_safe_release' AND c.checked_ms IS NOT NULL
          AND r.status='held' AND r.cancelled_ms IS NULL
          AND (r.watch_closed=0 OR NOT EXISTS
            (SELECT 1 FROM acquisition_request_suspensions s WHERE s.request_id=r.id))`).all();
      const targets = db.prepare(`SELECT t.episode_id AS episodeId FROM request_targets rt
        JOIN targets t ON t.id=rt.target_id WHERE rt.request_id=? AND t.anidb_id=?
        ORDER BY t.episode_id`);
      const oldMemo = db.prepare("SELECT 1 FROM sqlite_master WHERE name='acquisition_candidate_checks'").get()
        ? db.prepare('SELECT targets_json,result_json FROM acquisition_candidate_checks WHERE anidb_id=?') : null;
      const wake = db.prepare(`UPDATE acquisition_request_checks
        SET next_due_ms=MIN(COALESCE(next_due_ms,checked_ms+60000),checked_ms+60000)
        WHERE request_id=? AND verification_policy_revision<2`);
      const oldPolicies = ['quality-policy-v8','quality-policy-season-pack-v6',
        'quality-policy-episode-fallback-v6','quality-policy-uncertain-pack-v6'];
      for (const row of legacyMisses) {
        const episodeIds = targets.all(row.requestId,row.anidbId).map(target => target.episodeId);
        if (!episodeIds.length) continue;
        const oldCursor = typeof row.fingerprint === 'string' && row.fingerprint.includes(':') &&
          validCandidateFingerprint(row.fingerprint) && oldPolicies.some(policy =>
            row.fingerprint.split(':')[0] === createHash('sha256')
              .update(JSON.stringify([policy,...episodeIds])).digest('hex'));
        const legacyWrongIdentity = !oldCursor && oldMemo?.all(row.anidbId).some(memo => {
          try {
            const result = JSON.parse(memo.result_json), savedTargets = JSON.parse(memo.targets_json);
            return result?.state === 'held' && result.reason === 'shoko_preview_wrong_identity' &&
              result._previewIdentityRevision !== 'absolute-scope-v1-provider-failure' &&
              Array.isArray(savedTargets) && savedTargets.some(id => episodeIds.includes(id));
          } catch { return false; }
        });
        if (oldCursor || legacyWrongIdentity) wake.run(row.requestId);
      }
      db.exec(`UPDATE acquisition_request_checks SET verification_policy_revision=2
        WHERE verification_policy_revision<2`);
      // Independent of memo retention and the old migration marker. In
      // particular, v321 already stamped suspended rows as revision 2.
      repairUnscheduledClosedMisses(db);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    // Recovery admission is independent of a mutable search result. Older
    // ordinary passes could hide a dispatch_unknown behind an empty search
    // or completion reason. Restore only durable unconfirmed dispatches, not
    // unsent reservations or live unfinished queue claims.
    if (!db.prepare('PRAGMA table_info(acquisition_request_checks)').all()
      .some(column => column.name === 'recovery_hold')) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(`ALTER TABLE acquisition_request_checks ADD COLUMN recovery_hold
          INTEGER NOT NULL DEFAULT 0 CHECK(recovery_hold IN (0,1));
          UPDATE acquisition_request_checks SET recovery_hold=1
            WHERE state='held' AND reason='interrupted_attempt_present'`);
        const hasTable = name => Boolean(db.prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
        if (hasTable('acquisition_attempts')) {
          const ended = ['acquisition_retirements','acquisition_releases','acquisition_rejections']
            .filter(hasTable).map(table => `AND NOT EXISTS
              (SELECT 1 FROM ${table} ended WHERE ended.attempt_id=a.id)`).join(' ');
          db.exec(`UPDATE acquisition_request_checks SET recovery_hold=1
            WHERE state IS NOT NULL AND request_id IN (
              SELECT r.id FROM requests r WHERE r.status='held' AND r.cancelled_ms IS NULL
                AND EXISTS (SELECT 1 FROM acquisition_attempts a WHERE a.request_id=r.id
                  AND a.status='dispatch_unknown' ${ended} AND ${pendingRecognitionSql(db, 'a')}))`);
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    db.exec('INSERT INTO acquisition_request_cursor VALUES (1,0,1) ON CONFLICT(id) DO NOTHING');
  } catch (error) { db.close(); throw error; }
  const cursor = db.prepare('SELECT after_id AS afterId,pass FROM acquisition_request_cursor WHERE id=1');
  // An unfinished claim remains excluded after a crash. A one-time request
  // stops acquiring after exact public proof; its saved history remains.
  // Active Airing watches continue so later episodes can be added.
  // A saved choice is new evidence, unlike an unchanged periodic search.
  // Remember the revision at claim time so a choice saved during an active
  // search is not swallowed by that search's eventual empty result.
  const newChoice = `c.reason IN ('no_safe_release','no_release_candidates') AND
    (json_extract(r.release_control,'$.phase')='chosen' OR
      (json_extract(r.release_control,'$.mode')='auto' AND
       json_extract(r.release_control,'$.phase')='consumed' AND
       json_extract(r.release_control,'$.selection') IS NULL)) AND
    json_extract(r.release_control,'$.revision')>c.checked_release_revision`;
  const nextSql = `SELECT r.id,r.anidb_id AS anidbId,
      CASE WHEN ${newChoice} THEN 0 ELSE COALESCE(c.candidate_offset,0) END AS candidateOffset,
      CASE WHEN ${newChoice} THEN NULL ELSE c.candidate_fingerprint END AS candidateFingerprint FROM requests r
    LEFT JOIN acquisition_request_checks c ON c.request_id=r.id
    LEFT JOIN acquisition_request_suspensions s ON s.request_id=r.id
    WHERE r.id>? AND r.status='held' AND r.cancelled_ms IS NULL AND
      s.request_id IS NULL AND COALESCE(c.recovery_hold,0)=0 AND
      ${cohortFilter}
      EXISTS (SELECT 1 FROM request_targets rt WHERE rt.request_id=r.id) AND
      (c.request_id IS NULL OR NOT ((r.monitor_future=0 OR r.watch_closed=1) AND
        ${currentRequestCompletionSql})) AND
      (c.request_id IS NULL OR (c.state IS NOT NULL AND (c.next_due_ms<=? OR (${newChoice}) OR
        ${changedRequestScopeSql} OR
        c.scan_target_count IS NOT NULL AND c.scan_target_count<>(
          SELECT COUNT(*) FROM request_targets rt2 WHERE rt2.request_id=r.id))))
    ORDER BY r.id LIMIT 1`;
  const next = db.prepare(nextSql);
  // A freshly saved request can take its first turn ahead of older due rows.
  // The same eligibility guards apply, and the ordinary cursor stays put.
  const fresh = db.prepare(nextSql.replace('r.id>?', 'r.id=?'));
  const advance = db.prepare('UPDATE acquisition_request_cursor SET after_id=? WHERE id=1 AND after_id=? AND pass=?');
  const wrap = db.prepare('UPDATE acquisition_request_cursor SET after_id=0,pass=pass+1 WHERE id=1 AND after_id=? AND pass=?');
  const claim = db.prepare(`INSERT INTO acquisition_request_checks(request_id,pass,state,reason,attempt_id,checked_ms,next_due_ms,scan_started_ms,scan_scope,scan_target_count,scan_targets_json,checked_release_revision,coverage_policy_revision,request_scope_policy_revision,verification_policy_revision)
    VALUES (?,?,NULL,NULL,NULL,NULL,NULL,?,?,?,?,COALESCE((SELECT json_extract(release_control,'$.revision') FROM requests WHERE id=?),0),1,2,2) ON CONFLICT(request_id) DO UPDATE SET
    pass=excluded.pass,state=NULL,coverage_policy_revision=1,request_scope_policy_revision=2,verification_policy_revision=2,
    reason=CASE WHEN acquisition_request_checks.reason IN
      ('season_pack_scan_complete','season_pack_uncertain_complete')
      THEN acquisition_request_checks.reason ELSE NULL END,
    attempt_id=NULL,checked_ms=NULL,next_due_ms=NULL,
    search_policy_rechecked=CASE WHEN search_policy_rechecked=1 THEN 2
      ELSE search_policy_rechecked END,
    decision_ms=CASE WHEN scan_scope IS NOT NULL AND scan_scope<>excluded.scan_scope
      THEN NULL ELSE decision_ms END,
    scan_started_ms=CASE WHEN scan_scope IS NOT NULL AND scan_scope<>excluded.scan_scope
      THEN excluded.scan_started_ms
      ELSE COALESCE(acquisition_request_checks.scan_started_ms,excluded.scan_started_ms) END,
    scan_scope=excluded.scan_scope,scan_target_count=excluded.scan_target_count,
    scan_targets_json=excluded.scan_targets_json,
    checked_release_revision=COALESCE((SELECT json_extract(release_control,'$.revision')
      FROM requests WHERE id=excluded.request_id),0),
    candidate_offset=CASE WHEN reason IN ('no_safe_release','no_release_candidates')
      AND COALESCE((SELECT json_extract(release_control,'$.revision') FROM requests
        WHERE id=excluded.request_id),0)>checked_release_revision THEN 0 ELSE candidate_offset END,
    candidate_fingerprint=CASE WHEN reason IN ('no_safe_release','no_release_candidates')
      AND COALESCE((SELECT json_extract(release_control,'$.revision') FROM requests
        WHERE id=excluded.request_id),0)>checked_release_revision THEN NULL ELSE candidate_fingerprint END`);
  const targetScope = db.prepare(`SELECT t.anidb_id,t.episode_id FROM targets t
    JOIN request_targets rt ON rt.target_id=t.id WHERE rt.request_id=? ORDER BY t.episode_id,t.anidb_id`);
  const claimRequest = (id, pass, nowMs) => {
    const targets = targetScope.all(id);
    return claim.run(id, pass, nowMs,
      createHash('sha256').update(JSON.stringify(targets)).digest('hex'), targets.length,
      JSON.stringify(targets.map(t => [t.anidb_id,t.episode_id])), id);
  };
  const save = db.prepare(`UPDATE acquisition_request_checks SET
    state=?,reason=?,attempt_id=?,checked_ms=?,next_due_ms=?,empty_since_ms=?,
    metadata_since_ms=?,
    scan_started_ms=?,
    candidate_offset=COALESCE(?,candidate_offset),
      candidate_fingerprint=COALESCE(?,candidate_fingerprint),
      decision_ms=COALESCE(decision_ms,?),
      recovery_hold=CASE WHEN ?='interrupted_attempt_present' THEN 1 ELSE recovery_hold END
    WHERE request_id=? AND pass=? AND state IS NULL`);
  const result = db.prepare(`SELECT request_id AS requestId,pass,state,reason,
    attempt_id AS attemptId,candidate_offset AS candidateOffset,
    candidate_fingerprint AS candidateFingerprint,
    checked_ms AS checkedMs,next_due_ms AS nextDueMs,
    empty_since_ms AS emptySinceMs,metadata_since_ms AS metadataSinceMs,
    scan_started_ms AS scanStartedMs
    FROM acquisition_request_checks WHERE request_id=?`);
  const wakeRecovered = db.prepare(`UPDATE acquisition_request_checks
    SET state='held',reason='reconciled_observed_attempts',attempt_id=NULL,
      next_due_ms=?,candidate_offset=0,candidate_fingerprint=NULL
    WHERE request_id=? AND state IS NOT NULL AND
      EXISTS (SELECT 1 FROM requests r WHERE r.id=request_id AND
        r.status='held' AND r.cancelled_ms IS NULL)`);
  const waitingForMetadata = db.prepare(`SELECT r.id FROM requests r
    JOIN acquisition_request_checks c ON c.request_id=r.id
    LEFT JOIN acquisition_request_suspensions s ON s.request_id=r.id
    WHERE r.anidb_id=? AND r.status='held' AND r.cancelled_ms IS NULL
      AND s.request_id IS NULL AND c.state='held'
      AND c.reason='shoko_metadata_missing' AND c.next_due_ms>?`);
  // An RSS observation permits a fresh guarded search during a group wait.
  // Only scheduling changes: the independent per-episode fallback deadline,
  // unfinished claims, recovery holds and migration suspensions remain intact.
  const wakePreferred = db.prepare(`UPDATE acquisition_request_checks
    SET next_due_ms=? WHERE request_id=? AND state='held'
      AND reason='preferred_group_wait' AND recovery_hold=0 AND next_due_ms>?
      AND NOT EXISTS (SELECT 1 FROM acquisition_request_suspensions s
        WHERE s.request_id=acquisition_request_checks.request_id)
      AND EXISTS (SELECT 1 FROM requests r WHERE r.id=acquisition_request_checks.request_id
        AND r.status='held' AND r.cancelled_ms IS NULL AND ${cohortFilter}
        EXISTS (SELECT 1 FROM request_targets rt WHERE rt.request_id=r.id))`);
  const wakeMetadata = db.prepare(`UPDATE acquisition_request_checks
    SET next_due_ms=? WHERE request_id=? AND state='held'
      AND reason='shoko_metadata_missing' AND next_due_ms>?`);
  const pendingMetadata = db.prepare(`SELECT r.id AS requestId,
      CASE WHEN ${changedRequestScopeSql} OR c.scan_target_count IS NOT NULL AND c.scan_target_count<>
        (SELECT COUNT(*) FROM request_targets rt2 WHERE rt2.request_id=r.id)
        THEN 0 ELSE c.next_due_ms END AS nextDueMs
    FROM requests r JOIN acquisition_request_checks c ON c.request_id=r.id
    LEFT JOIN acquisition_request_suspensions s ON s.request_id=r.id
    WHERE r.status='held' AND r.cancelled_ms IS NULL
      AND s.request_id IS NULL AND c.recovery_hold=0 AND ${cohortFilter}
      EXISTS (SELECT 1 FROM request_targets rt WHERE rt.request_id=r.id) AND
      c.state IS NOT NULL AND (c.next_due_ms IS NOT NULL OR ${changedRequestScopeSql}) AND
      NOT ((r.monitor_future=0 OR r.watch_closed=1) AND ${currentRequestCompletionSql})
    ORDER BY nextDueMs,r.id LIMIT ?`);
  const advanceLegacyMetadata = db.prepare(`UPDATE acquisition_request_checks
    SET metadata_since_ms=COALESCE(checked_ms,?),
      next_due_ms=MIN(next_due_ms,?)
    WHERE state='held' AND reason='shoko_metadata_missing'
      AND metadata_since_ms IS NULL AND next_due_ms>?
      AND EXISTS (SELECT 1 FROM requests r WHERE r.id=request_id
        AND r.status='held' AND r.cancelled_ms IS NULL)`);
  const observedInterruptedSql = `SELECT c.request_id AS requestId
    FROM acquisition_request_checks c
    WHERE c.state IS NOT NULL AND (c.recovery_hold=1 OR (c.state='held' AND c.reason='interrupted_attempt_present'
      AND c.next_due_ms IS NULL) OR
      (c.reason='reconciled_observed_attempts' AND c.next_due_ms<=?))
      AND EXISTS (SELECT 1 FROM requests r
        WHERE r.id=c.request_id
          AND r.status='held' AND r.cancelled_ms IS NULL AND
          ${cohortFilter} 1=1)
      AND NOT EXISTS (SELECT 1 FROM acquisition_request_suspensions s
        WHERE s.request_id=c.request_id)
      AND EXISTS (SELECT 1 FROM acquisition_attempts a
        WHERE a.request_id=c.request_id)
      AND NOT EXISTS (SELECT 1 FROM acquisition_attempts a
        WHERE a.request_id=c.request_id AND ${unreconciledAttemptSql(db, 'a')})`;
  const resumeObservedSql = `UPDATE acquisition_request_checks
    SET state='held',reason='reconciled_observed_attempts',recovery_hold=0,
      next_due_ms=CASE WHEN recovery_hold=1 THEN ? ELSE COALESCE(next_due_ms,?) END
    WHERE request_id=? AND state IS NOT NULL
      AND (recovery_hold=1 OR (reason='interrupted_attempt_present' AND next_due_ms IS NULL)
        OR (reason='reconciled_observed_attempts' AND next_due_ms<=?))`;
  let observedInterrupted;
  let resumeObserved;
  const watch = db.prepare('SELECT monitor_future,watch_closed FROM requests WHERE id=?');
  const unresolved = db.prepare(`SELECT request_id AS requestId,pass
    FROM acquisition_request_checks WHERE request_id>? AND state IS NULL
    ORDER BY request_id LIMIT ?`);
  const suspendable = db.prepare(`SELECT r.id FROM requests r
    LEFT JOIN acquisition_request_checks c ON c.request_id=r.id
    WHERE r.id=? AND r.status='held' AND r.cancelled_ms IS NULL
      AND (c.request_id IS NULL OR
        (c.state IS NOT NULL AND c.attempt_id IS NULL))`);
  let startedForCutover;
  const inFlightRequest = db.prepare(`SELECT 1 FROM acquisition_request_checks
    WHERE request_id=? AND state IS NULL`);
  const hasStage = db.prepare(`SELECT 1 FROM sqlite_master
    WHERE type='table' AND name=?`);
  const inFlightStages = new Map();
  const activeStageForRequest = (requestId) => {
    for (const table of ['start_checks', 'completion_checks',
      'handoff_publish_checks', 'pure_move_completion_checks', 'pure_move_publish_checks']) {
      if (!hasStage.get(table)) continue;
      if (!inFlightStages.has(table)) {
        inFlightStages.set(table, db.prepare(`SELECT 1 FROM ${table} c
          JOIN acquisition_attempts a ON a.id=c.attempt_id
          WHERE a.request_id=? AND c.state IS NULL LIMIT 1`));
      }
      if (inFlightStages.get(table).get(requestId)) return true;
    }
    return false;
  };
  const hasAttemptLedger = db.prepare(`SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='acquisition_attempts'`);
  let attemptForRequest;
  const suspended = db.prepare(`SELECT request_id AS requestId,reason,
    recorded_ms AS recordedMs FROM acquisition_request_suspensions
    WHERE request_id=?`);
  const insertSuspension = db.prepare(`INSERT INTO acquisition_request_suspensions
    (request_id,reason,recorded_ms) VALUES (?,?,?)
    ON CONFLICT(request_id) DO NOTHING`);
  const deleteSuspension = db.prepare(`DELETE FROM acquisition_request_suspensions
    WHERE request_id=?`);
  const transact = (action) => {
    let begun = false;
    try {
      db.exec('BEGIN IMMEDIATE'); begun = true;
      const value = action();
      db.exec('COMMIT'); begun = false;
      return value;
    } catch (error) {
      if (begun) db.exec('ROLLBACK');
      throw error;
    }
  };
  const unstarted = (requestId) => {
    if (hasAttemptLedger.get()) {
      attemptForRequest ??= db.prepare(`SELECT 1 FROM acquisition_attempts
        WHERE request_id=? LIMIT 1`);
    }
    return Boolean(suspendable.get(requestId)) &&
      !attemptForRequest?.get(requestId);
  };
  return {
    suspendForCutover({ requestId, reason, nowMs = Date.now() } = {}) {
      if (!validId(requestId) || typeof reason !== 'string' ||
          !/^[a-z][a-z0-9_]{0,79}$/.test(reason) || !validTime(nowMs)) {
        throw new TypeError('Invalid started request cutover hold');
      }
      return transact(() => {
        if (inFlightRequest.get(requestId) ||
            activeStageForRequest(requestId)) {
          return held('request_inflight');
        }
        if (suspended.get(requestId)) return { state: 'suspended' };
        if (!hasAttemptLedger.get()) {
          return held('request_not_started_or_unavailable');
        }
        startedForCutover ??= db.prepare(`SELECT r.id FROM requests r
          WHERE r.id=? AND r.status='held' AND r.cancelled_ms IS NULL AND
            EXISTS (SELECT 1 FROM acquisition_attempts a
              WHERE a.request_id=r.id)`);
        if (!startedForCutover.get(requestId)) {
          return held('request_not_started_or_unavailable');
        }
        insertSuspension.run(requestId, reason, nowMs);
        return { state: 'suspended' };
      });
    },
    suspendUnstarted({ requestId, reason, nowMs = Date.now() } = {}) {
      if (!validId(requestId) || typeof reason !== 'string' ||
          !/^[a-z][a-z0-9_]{0,79}$/.test(reason) || !validTime(nowMs)) {
        throw new TypeError('Invalid request suspension');
      }
      return transact(() => {
        if (suspended.get(requestId)) return { state: 'suspended' };
        if (!unstarted(requestId)) {
          return held('request_started_or_unavailable');
        }
        insertSuspension.run(requestId, reason, nowMs);
        return { state: 'suspended' };
      });
    },
    suspendUnstartedBatch({ requestIds, reason, nowMs = Date.now() } = {}) {
      if (!Array.isArray(requestIds) || requestIds.length < 1 ||
          requestIds.length > 50 || requestIds.some((id) => !validId(id)) ||
          new Set(requestIds).size !== requestIds.length ||
          typeof reason !== 'string' ||
          !/^[a-z][a-z0-9_]{0,79}$/.test(reason) || !validTime(nowMs)) {
        throw new TypeError('Invalid request suspension batch');
      }
      return transact(() => {
        if (requestIds.some((requestId) => !unstarted(requestId))) {
          return held('request_started_or_unavailable');
        }
        for (const requestId of requestIds) {
          insertSuspension.run(requestId, reason, nowMs);
        }
        return { state: 'suspended', count: requestIds.length };
      });
    },
    resumeSuspended({ requestId } = {}) {
      if (!validId(requestId)) throw new TypeError('Invalid suspended request');
      return transact(() => {
        if (deleteSuspension.run(requestId).changes !== 1) return held('not_suspended');
        repairUnscheduledClosedMisses(db, requestId);
        return { state: 'resumed' };
      });
    },
    getSuspension(requestId) {
      if (!validId(requestId)) throw new TypeError('Invalid request ID');
      const row = suspended.get(requestId);
      return row ? { ...row } : null;
    },
    wakePreferredGroupWait({ requestId, nowMs = Date.now() } = {}) {
      if (!validId(requestId) || !validTime(nowMs)) {
        throw new TypeError('Invalid preferred-group release wake');
      }
      return transact(() => wakePreferred.run(nowMs, requestId, nowMs,
        ...(allowedAnidbIds ?? [])).changes === 1
        ? { state: 'woken' } : held('request_not_wakeable'));
    },
    wakeHydratedTitle({ anidbId, nowMs = Date.now() } = {}) {
      if (!validId(anidbId) || !validTime(nowMs)) {
        throw new TypeError('Invalid hydrated title wake');
      }
      if (allowedAnidbIds !== null && !allowedAnidbIds.includes(anidbId)) {
        return [];
      }
      return transact(() => {
        const ids = waitingForMetadata.all(anidbId, nowMs)
          .map((row) => row.id);
        return ids.filter((id) => wakeMetadata.run(nowMs, id, nowMs).changes === 1);
      });
    },
    listMetadataRetries({ limit = 32, nowMs = Date.now() } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32 ||
          !validTime(nowMs) || !validTime(nowMs + METADATA_SHORT_RETRY_MS)) {
        throw new TypeError('Invalid metadata retry page');
      }
      return transact(() => {
        // Older releases saved this reason with the generic 30-minute delay.
        // Bring those rows forward once while retaining their original age.
        advanceLegacyMetadata.run(nowMs, nowMs + METADATA_SHORT_RETRY_MS,
          nowMs + METADATA_SHORT_RETRY_MS);
        return pendingMetadata.all(...(allowedAnidbIds ?? []), limit)
          .map((row) => ({ ...row }));
      });
    },
    wakeRecognitionRecovery({ requestId, nowMs }) {
      if (!validId(requestId) || !validTime(nowMs)) {
        throw new TypeError('Invalid recovered request wake');
      }
      return transact(() => wakeRecovered.run(nowMs, requestId).changes === 1
        ? { state: 'woken' } : held('request_not_wakeable'));
    },
    wakeAfterMediaRetirement({ requestId, nowMs }) {
      if (!validId(requestId) || !validTime(nowMs)) {
        throw new TypeError('Invalid media retirement wake');
      }
      return transact(() => wakeRecovered.run(nowMs, requestId).changes === 1
        ? { state: 'woken' } : held('request_not_wakeable'));
    },
    resumeObservedAttemptHolds({ nowMs = Date.now() } = {}) {
      if (!validTime(nowMs)) throw new TypeError('Invalid interrupted retry clock');
      if (!hasAttemptLedger.get() || !hasStage.get('acquisition_target_claims')) {
        return [];
      }
      observedInterrupted ??= db.prepare(observedInterruptedSql);
      resumeObserved ??= db.prepare(resumeObservedSql);
      return transact(() => observedInterrupted.all(nowMs, ...(allowedAnidbIds ?? []))
        .map((row) => row.requestId)
        .filter((id) => resumeObserved.run(nowMs, nowMs, id, nowMs).changes === 1));
    },
    claimNext({ nowMs = Date.now(), priorityRequestId = null } = {}) {
      if (!validTime(nowMs) ||
          (priorityRequestId !== null && !validId(priorityRequestId))) {
        throw new TypeError('Invalid acquisition queue claim');
      }
      return transact(() => {
        const position = cursor.get();
        if (priorityRequestId !== null) {
          const row = fresh.get(priorityRequestId,
            ...(allowedAnidbIds ?? []), nowMs);
          if (row) {
            const ownership = ownershipGate?.status(row.anidbId) ?? 'eligible';
            if (ownership === 'eligible') {
              claimRequest(row.id, position.pass, nowMs);
              return { state: 'claimed', requestId: row.id, pass: position.pass,
                ...(row.candidateOffset > 0 ? { candidateOffset: row.candidateOffset } : {}),
                ...(row.candidateFingerprint ?
                  { candidateFingerprint: row.candidateFingerprint } : {}) };
            }
            if (!['owned', 'unmapped'].includes(ownership)) {
              return held('sonarr_ownership_unavailable');
            }
          }
        }
        let afterId = position.afterId;
        for (let scanned = 0; scanned < 1_000; scanned++) {
          const row = next.get(afterId, ...(allowedAnidbIds ?? []), nowMs);
          if (!row) {
            if (wrap.run(afterId, position.pass).changes !== 1) {
              throw new Error('Acquisition cursor changed');
            }
            return { state: 'pass_complete', pass: position.pass };
          }
          const ownership = ownershipGate?.status(row.anidbId) ?? 'eligible';
          if (!['eligible', 'owned', 'unmapped'].includes(ownership)) {
            return held('sonarr_ownership_unavailable');
          }
          if (advance.run(row.id, afterId, position.pass).changes !== 1) {
            throw new Error('Acquisition cursor changed');
          }
          afterId = row.id;
          if (ownership !== 'eligible') continue;
          claimRequest(row.id, position.pass, nowMs);
          return { state: 'claimed', requestId: row.id, pass: position.pass,
            ...(row.candidateOffset > 0 ? { candidateOffset: row.candidateOffset } : {}),
            ...(row.candidateFingerprint ?
              { candidateFingerprint: row.candidateFingerprint } : {}) };
        }
        return held('queue_scan_limit');
      });
    },
    recordResult({ requestId, pass, state, reason = null, attemptId = null,
      nextCandidateOffset = null, nextCandidateFingerprint = null, checkedMs, retryAtMs = null }) {
      if (!validId(requestId) || !validId(pass) ||
          !['held', 'stopped_observed'].includes(state) ||
          (state === 'held' ? typeof reason !== 'string' ||
            !/^[a-z][a-z0-9_]{0,79}$/.test(reason) || attemptId !== null :
            reason !== null || !validId(attemptId)) ||
          (nextCandidateOffset !== null &&
            (!Number.isSafeInteger(nextCandidateOffset) ||
              nextCandidateOffset < 0 || nextCandidateOffset > 50)) ||
          (nextCandidateFingerprint !== null &&
            !validCandidateFingerprint(nextCandidateFingerprint)) ||
          (retryAtMs !== null && (!validTime(retryAtMs) ||
            (retryAtMs < checkedMs && reason !== 'preferred_group_wait') ||
            retryAtMs > checkedMs + 7_200_000)) ||
          !validTime(checkedMs) || !validTime(checkedMs + RETRY_DELAY_MS)) {
        throw new TypeError('Invalid acquisition check result');
      }
      const previous = result.get(requestId);
      // A saved cursor that moved forward cannot revisit the same release in
      // the next pass. Keep the normal backoff for outages, stationary cursors
      // and a completed sweep, while allowing a different candidate at the
      // pipeline's existing paced request stage.
      const completedSeasonPhase =
        ['season_pack_scan_complete', 'season_pack_uncertain_complete'].includes(reason) &&
        previous?.candidateFingerprint != null &&
        previous.candidateFingerprint !== nextCandidateFingerprint &&
        nextCandidateOffset === previous.candidateOffset;
      // Completion saves the next phase's fingerprint before its first page.
      // Its offset starts again at zero, so a lower positive offset is still
      // progress within that new phase rather than a stalled sweep.
      const enteredSeasonPhase = reason === 'season_pack_search_pending' &&
        ['season_pack_scan_complete', 'season_pack_uncertain_complete']
          .includes(previous?.reason) &&
        previous.candidateFingerprint === nextCandidateFingerprint &&
        nextCandidateOffset > 0 &&
        nextCandidateOffset < previous.candidateOffset;
      const advanced = previous?.pass === pass && previous.state === null &&
        nextCandidateFingerprint !== null &&
        nextCandidateOffset !== null &&
        (nextCandidateOffset > previous.candidateOffset ||
          completedSeasonPhase || enteredSeasonPhase);
      const newScanPolicy = previous?.candidateFingerprint &&
        nextCandidateFingerprint && !completedSeasonPhase &&
        previous.candidateFingerprint.split(':')[0] !==
          nextCandidateFingerprint.split(':')[0];
      const empty = state === 'held' &&
        ['no_release_candidates', 'no_safe_release'].includes(reason);
      const emptySinceMs = empty ? previous?.emptySinceMs ?? checkedMs : null;
      const metadataMissing = state === 'held' &&
        reason === 'shoko_metadata_missing';
      const metadataSinceMs = metadataMissing &&
        validTime(previous?.metadataSinceMs) &&
        previous.metadataSinceMs !== null &&
        previous.metadataSinceMs <= checkedMs
        ? previous.metadataSinceMs : metadataMissing ? checkedMs : null;
      const metadataDelayMs = metadataMissing &&
        checkedMs - metadataSinceMs < METADATA_SHORT_WINDOW_MS
        ? METADATA_SHORT_RETRY_MS : RETRY_DELAY_MS;
      const watched = watch.get(requestId);
      const elapsed = checkedMs - (emptySinceMs ?? checkedMs);
      const emptyDelayMs = elapsed >= 7 * 86_400_000 ? 86_400_000 :
        elapsed >= 86_400_000 ? 6 * 3_600_000 : 3_600_000;
      // A valid group deadline can expire while the processor is working.
      // Record that completed check as ready now instead of stranding its claim.
      const preferredRetryMs = retryAtMs === null ? null : Math.max(checkedMs, retryAtMs);
      const nextDueMs = reason==='availability_check_pending' ? checkedMs+COVERAGE_CONTINUATION_MS : reason==='preferred_group_wait'&&preferredRetryMs!==null?preferredRetryMs:reason === 'interrupted_attempt_present'
        ? null : reason === 'candidate_scan_time_budget'
          ? checkedMs + SESSION_RETRY_MS :
          REQUEST_RELATED_RETRY_HOLDS.includes(reason)
            ? checkedMs + RELATED_RETRY_MS :
          state === 'stopped_observed' ? checkedMs + 60_000 :
          (advanced || newScanPolicy) ?
            checkedMs : checkedMs +
          (REQUEST_SESSION_RETRY_HOLDS.includes(reason)
            ? SESSION_RETRY_MS : metadataMissing ? metadataDelayMs :
              empty && watched?.monitor_future === 1 &&
              watched.watch_closed === 0 ? emptyDelayMs : RETRY_DELAY_MS);
      const scanStartedMs = previous?.scanStartedMs ?? checkedMs;
      const decisionMs = state === 'stopped_observed' || reason === 'request_fully_available' ||
        ['no_safe_release','no_release_candidates'].includes(reason) && nextCandidateOffset === 0
        ? checkedMs : null;
      return save.run(state, reason, attemptId, checkedMs, nextDueMs,
        emptySinceMs, metadataSinceMs, scanStartedMs,
        nextCandidateOffset, nextCandidateFingerprint, decisionMs, reason,
        requestId, pass).changes === 1
        ? { state: 'recorded' } : held('stale_claim');
    },
    getResult(requestId) {
      if (!validId(requestId)) throw new TypeError('Invalid request ID');
      const row = result.get(requestId);
      if (!row) return null;
      const { candidateOffset, candidateFingerprint, emptySinceMs,
        metadataSinceMs, scanStartedMs, ...other } = row;
      return { ...other,
        ...(candidateOffset > 0 ? { candidateOffset } : {}),
        ...(candidateFingerprint ? { candidateFingerprint } : {}) };
    },
    getScanStartedMs(requestId) {
      if (!validId(requestId)) throw new TypeError('Invalid request ID');
      return result.get(requestId)?.scanStartedMs ?? null;
    },
    getDecisionTiming(requestId) {
      const row = db.prepare(`SELECT scan_started_ms AS startedMs,
        decision_ms AS decisionMs FROM acquisition_request_checks WHERE request_id=?`).get(requestId);
      if(row?.startedMs!==null&&row?.startedMs!==undefined){
        const intentionalGroupWaitMs=preferredWaitDuration(db,requestId,row.startedMs,row.decisionMs??Date.now());
        if(intentionalGroupWaitMs>0)return {...row,intentionalGroupWaitMs,
          wallElapsedMs:row.decisionMs===null?null:row.decisionMs-row.startedMs,
          elapsedMs:row.decisionMs===null?null:Math.max(0,row.decisionMs-row.startedMs-intentionalGroupWaitMs)};
      }
      return row && row.startedMs !== null ? { ...row,
        elapsedMs: row.decisionMs === null ? null : row.decisionMs - row.startedMs } : null;
    },
    listUnresolved({ afterId = 0, limit = 20 } = {}) {
      if (!Number.isSafeInteger(afterId) || afterId < 0 ||
          !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
        throw new TypeError('Invalid unresolved claim page');
      }
      return unresolved.all(afterId, limit).map((row) => ({ ...row }));
    },
    close() { db.close(); },
  };
}

// One bounded page. Each request is claimed before processing, so a failure
// in one title cannot stop later titles or issue two claims in the same pass.
export function createAcquisitionPageWorker({ queue, processRequest,
  limit = 3, now = Date.now } = {}) {
  if (typeof queue?.claimNext !== 'function' ||
      typeof queue?.recordResult !== 'function' ||
      typeof processRequest !== 'function' || typeof now !== 'function' ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 10) {
    throw new TypeError('Invalid acquisition page worker');
  }
  let busy = false;
  return {
    async runOnce({ priorityRequestId = null } = {}) {
      if (busy) return held('page_in_progress');
      busy = true;
      const results = [];
      try {
        for (let i = 0; i < limit; i++) {
          let next;
          try { next = queue.claimNext({ nowMs: now(),
            priorityRequestId: i === 0 ? priorityRequestId : null }); }
          catch { return { state: 'held', reason: 'queue_unavailable', results }; }
          if (next.state === 'pass_complete') {
            return { state: 'pass_complete', pass: next.pass, results };
          }
          if (next.state !== 'claimed') return { ...next, results };
          let outcome;
          try { outcome = await processRequest({ requestId: next.requestId,
            pass: next.pass,
            scanStartedMs: typeof queue.getScanStartedMs === 'function'
              ? queue.getScanStartedMs(next.requestId) : undefined,
            candidateOffset: next.candidateOffset ?? 0,
            candidateFingerprint: next.candidateFingerprint ?? null }); }
          catch (error) { outcome = heldAfter(error, 'worker_unavailable'); }
          if ((outcome?.nextCandidateOffset !== undefined &&
              (!Number.isSafeInteger(outcome.nextCandidateOffset) ||
                outcome.nextCandidateOffset < 0 || outcome.nextCandidateOffset > 50)) ||
              (outcome?.nextCandidateFingerprint !== undefined &&
                !validCandidateFingerprint(outcome.nextCandidateFingerprint)) ||
              (outcome?.state === 'stopped_observed' && !validId(outcome.attemptId)) ||
              (outcome?.state !== 'stopped_observed' &&
              (outcome?.state !== 'held' ||
                typeof outcome.reason !== 'string' ||
                !/^[a-z][a-z0-9_]{0,79}$/.test(outcome.reason)))) {
            outcome = held('worker_unavailable');
          }
          const state = outcome.state;
          const reason = state === 'held' ? outcome.reason : null;
          try {
            const saved = queue.recordResult({ requestId: next.requestId,
              pass: next.pass, state, reason,
              attemptId: state === 'stopped_observed' ? outcome.attemptId : null,
              nextCandidateOffset: outcome.nextCandidateOffset ?? null,
              nextCandidateFingerprint: outcome.nextCandidateFingerprint ?? null,
              retryAtMs: outcome.retryAtMs??null,
              checkedMs: now() });
            if (saved.state !== 'recorded') return { state: 'held',
              reason: 'queue_unavailable', results };
          } catch { return { state: 'held', reason: 'queue_unavailable', results }; }
          const check = queue.getResult(next.requestId);
          const continuing = state === 'held' && check?.nextDueMs !== null &&
            check?.nextDueMs <= now() && (check?.candidateOffset > 0 ||
              reason?.startsWith('season_pack_'));
          results.push({ requestId: next.requestId, state,
            ...(state === 'stopped_observed' ? { attemptId: outcome.attemptId } : {}),
            ...(reason === null ? {} : { reason }),
            ...(continuing ? { continuationDueMs: check.nextDueMs } : {}),
            ...(Number.isSafeInteger(check?.nextDueMs) ? { nextDueMs: check.nextDueMs } : {}) });
        }
        return { state: 'page', results };
      } finally { busy = false; }
    },
  };
}

// Invoke before starting request workers after a restart. The acquisition
// ledger must prove that a claim has no saved attempt before it can retry.
// A saved attempt becomes a visible, non-retrying review hold because it
// may predate the claim or represent an interrupted provider dispatch.
export async function reconcileUnresolvedAcquisitionClaims({ queue,
  inspectRequest, now = Date.now, limit = 20 } = {}) {
  if (typeof queue?.listUnresolved !== 'function' ||
      typeof queue?.recordResult !== 'function' ||
      typeof inspectRequest !== 'function' || typeof now !== 'function' ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new TypeError('Invalid acquisition claim recovery');
  }
  const resolved = [];
  const heldClaims = [];
  let afterId = 0;
  while (true) {
    const claims = queue.listUnresolved({ afterId, limit });
    if (claims.length === 0) break;
    for (const claim of claims) {
      let observation;
      try { observation = await inspectRequest(claim.requestId); }
      catch { observation = null; }
      if (observation?.state === 'attempt_present') {
        try {
          const saved = queue.recordResult({ requestId: claim.requestId,
            pass: claim.pass, state: 'held',
            reason: 'interrupted_attempt_present', checkedMs: now() });
          if (saved.state === 'recorded') resolved.push(claim.requestId);
          else heldClaims.push(claim.requestId);
        } catch { heldClaims.push(claim.requestId); }
        continue;
      }
      if (observation?.state !== 'no_attempt') {
        heldClaims.push(claim.requestId);
        continue;
      }
      try {
        const saved = queue.recordResult({ requestId: claim.requestId,
          pass: claim.pass, state: 'held', reason: 'reconciled_no_dispatch',
          checkedMs: now() });
        if (saved.state === 'recorded') resolved.push(claim.requestId);
        else heldClaims.push(claim.requestId);
      } catch { heldClaims.push(claim.requestId); }
    }
    afterId = claims.at(-1).requestId;
    if (claims.length < limit) break;
  }
  return { state: 'reviewed', resolved, held: heldClaims };
}
