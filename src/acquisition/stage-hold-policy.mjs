// Shared retry policy for durable stage holds.
//
// A hold reason here is a failed *observation* (a provider, mount, session or
// worker was briefly unavailable), never evidence about the torrent or files.
// Such a hold always gets another paced turn through the normal guarded
// worker; it never becomes terminal review just because an earlier claim of
// the same attempt also retried. Every retry re-runs every gate, so this
// grants no start, import or bypass by itself.

const MINUTE_MS = 60_000;
const TRANSIENT_BASE_MS = 30 * MINUTE_MS;
const TRANSIENT_MAX_MS = 6 * 60 * MINUTE_MS;

// Reasons the start stage returns when a read failed or a check was cut off.
// Reasons that already have their own (shorter) start-queue schedule keep it.
export const TRANSIENT_START_HOLDS = Object.freeze([
  'worker_unavailable', 'interrupted_before_intent',
  'attempt_unavailable', 'request_unavailable',
  'sonarr_ownership_unavailable',
  'availability_unavailable', 'availability_clock_invalid',
  'staging_root_unverified', 'mount_evidence_unavailable',
  'torrent_unavailable', 'passive_exclusion_unconfirmed',
  'provider_timeout', 'provider_transport', 'provider_http_error',
  'provider_invalid_response',
  'authentication_failed', 'authentication_forbidden', 'session_mismatch',
]);

// Publish preflight checks that run before any file is read or hashed. They
// can keep a paced retry without rehashing a batch (see the publish queue).
export const PREFLIGHT_PUBLISH_HOLDS = Object.freeze([
  'handoff_mount_unavailable', 'staging_root_unverified',
]);

// Start holds with their own short schedules (kept from earlier builds).
export const START_SESSION_RETRY_HOLDS = Object.freeze([
  // The owner can be re-enabled; a pause must not become terminal review.
  'account_access_changed', 'adult_access_disabled', 'restricted_or_unverified',
  'provider_unavailable', 'provider_http_403', 'authentication_backoff',
  'authentication_unavailable', 'metadata_reader_busy',
  'availability_evidence_stale', 'import_activity_unverified', 'file_selection_changed',
]);
export const START_METADATA_RETRY_HOLDS = Object.freeze([
  'detail_unavailable', 'related_title_unavailable', 'shoko_settings_unavailable',
]);

// Completion: failed provider observations (one-minute retry in pure mode)
// and holds that always retry after a minute.
export const COMPLETION_TRANSIENT_PROVIDER_HOLDS = Object.freeze([
  'provider_http_error', 'provider_unavailable', 'provider_timeout',
  'provider_transport', 'provider_invalid_response',
  'torrent_unavailable', 'torrent_unavailable_after_stop', 'stop_outcome_unknown',
]);
export const COMPLETION_SESSION_RETRY_HOLDS = Object.freeze([
  'provider_http_403', 'authentication_backoff',
  'authentication_unavailable', 'completion_transition', 'torrent_not_stopped',
  'torrent_still_present', 'staging_not_empty',
  'media_retirement_pending', 'media_retirement_unavailable',
]);

// Request search holds retried after a minute or after five minutes.
export const REQUEST_SESSION_RETRY_HOLDS = Object.freeze([
  'account_access_changed', 'adult_access_disabled', 'restricted_or_unverified',
  'provider_http_403', 'authentication_backoff',
  'authentication_unavailable', 'release_search_incomplete',
  'import_quiet_window_unverified', 'torrent_hash_in_use',
  'service_stopping', 'metadata_reader_busy', 'release_preflight_unavailable',
  'availability_evidence_stale', 'import_activity_unverified', 'file_selection_changed',
  'provider_unavailable', 'release_selection_pending',
  'release_choice_changed',
]);
export const REQUEST_RELATED_RETRY_HOLDS = Object.freeze([
  'related_title_unavailable', 'release_search_unavailable',
]);

const transientStart = new Set(TRANSIENT_START_HOLDS);
export const isTransientStartHold = (reason) => transientStart.has(reason);

// 30 min, 1 h, 2 h, 4 h, then every 6 h. `claims` is the queue's claim
// counter; it only lengthens the wait and can never end the retries.
export function transientRetryDelayMs(claims) {
  const step = Number.isSafeInteger(claims) && claims > 1
    ? Math.min(claims - 1, 8) : 0;
  return Math.min(TRANSIENT_BASE_MS * 2 ** step, TRANSIENT_MAX_MS);
}

// One-time, logged revival of rows that an earlier build parked in terminal
// review for a reason now classed as transient. Each revived row is written
// to stage_hold_policy_revivals first, so it can be put back exactly (see
// docs/stage-hold-policy.md). Rows reclaimed since then are not affected by
// that undo, because the claim version will have moved on.
export function reviveTransientHolds(db, { stage, table, reasons, extraWhere = '' }) {
  if (!/^[a-z_]+$/.test(stage) || !/^[a-z_]+$/.test(table) ||
      !Array.isArray(reasons) || reasons.length < 1) {
    throw new TypeError('Invalid hold revival');
  }
  db.exec(`CREATE TABLE IF NOT EXISTS stage_hold_policy_revivals (
    stage TEXT NOT NULL,
    attempt_id INTEGER NOT NULL CHECK(attempt_id>0),
    version INTEGER NOT NULL CHECK(version>0),
    reason TEXT NOT NULL,
    checked_ms INTEGER NOT NULL CHECK(checked_ms>=0),
    revived_ms INTEGER NOT NULL CHECK(revived_ms>=0),
    PRIMARY KEY(stage,attempt_id,version)
  ) STRICT`);
  const marks = reasons.map(() => '?').join(',');
  const where = `state='held' AND next_due_ms IS NULL AND checked_ms IS NOT NULL
    AND reason IN (${marks}) ${extraWhere}`;
  let begun = false;
  try {
    db.exec('BEGIN IMMEDIATE'); begun = true;
    db.prepare(`INSERT INTO stage_hold_policy_revivals
      (stage,attempt_id,version,reason,checked_ms,revived_ms)
      SELECT ?,attempt_id,version,reason,checked_ms,? FROM ${table} WHERE ${where}
      ON CONFLICT DO NOTHING`).run(stage, Date.now(), ...reasons);
    const revived = db.prepare(`UPDATE ${table} SET next_due_ms=checked_ms+60000
      WHERE ${where}`).run(...reasons).changes;
    db.exec('COMMIT'); begun = false;
    return revived;
  } catch (error) {
    if (begun) db.exec('ROLLBACK');
    throw error;
  }
}

// Admin actions on review holds. Every action is logged with the claim
// version it applied to, so a retry can be undone exactly and a release can
// only authorise the guarded retirement of that exact parked check.
export function ensureOperatorReviewLog(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS operator_review_actions (
    id INTEGER PRIMARY KEY,
    stage TEXT NOT NULL,
    attempt_id INTEGER NOT NULL CHECK(attempt_id>0),
    check_version INTEGER NOT NULL CHECK(check_version>0),
    action TEXT NOT NULL CHECK(action IN ('retry','release')),
    reason TEXT NOT NULL,
    checked_ms INTEGER CHECK(checked_ms>=0),
    actor_id INTEGER NOT NULL CHECK(actor_id>0),
    acted_ms INTEGER NOT NULL CHECK(acted_ms>=0)
  ) STRICT`);
}

// Make one parked review hold due now. Only a held row with no retry time
// (terminal review) qualifies; anything else is reported, never changed.
export function actOnReviewHold(db, { stage, table, attemptId, action,
  actorId, nowMs, extraWhere = '' }) {
  if (!/^[a-z_]+$/.test(stage) || !/^[a-z_]+$/.test(table) ||
      !['retry', 'release'].includes(action) ||
      !Number.isSafeInteger(attemptId) || attemptId < 1 ||
      !Number.isSafeInteger(actorId) || actorId < 1 ||
      !Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new TypeError('Invalid review action');
  }
  ensureOperatorReviewLog(db);
  let begun = false;
  try {
    db.exec('BEGIN IMMEDIATE'); begun = true;
    const row = db.prepare(`SELECT version,reason,checked_ms AS checkedMs
      FROM ${table} WHERE attempt_id=? AND state='held' AND next_due_ms IS NULL
      ${extraWhere}`).get(attemptId);
    if (!row) { db.exec('ROLLBACK'); begun = false; return { state: 'held', reason: 'not_in_review' }; }
    db.prepare(`INSERT INTO operator_review_actions
      (stage,attempt_id,check_version,action,reason,checked_ms,actor_id,acted_ms)
      VALUES (?,?,?,?,?,?,?,?)`).run(stage, attemptId, row.version, action,
      row.reason, row.checkedMs, actorId, nowMs);
    if (action === 'retry') {
      db.prepare(`UPDATE ${table} SET next_due_ms=? WHERE attempt_id=? AND version=?`)
        .run(nowMs, attemptId, row.version);
    }
    db.exec('COMMIT'); begun = false;
    return { state: action === 'retry' ? 'retry_scheduled' : 'release_recorded',
      version: row.version };
  } catch (error) {
    if (begun) db.exec('ROLLBACK');
    throw error;
  }
}
