import { pendingRecognitionSql, unreconciledAttemptSql } from '../acquisition/recognition-release-sql.mjs';
import { DatabaseSync } from 'node:sqlite';
import { createRequestCompletionReader } from './request-completion-history.mjs';

// Read-only journal summary for a request page. It never infers Plex playback
// from a torrent, a Shoko import intent, or a private handoff record.
export function openRequestProgress(dbPath, { now = Date.now,
  pureMode = false } = {}) {
  if (typeof dbPath !== 'string' || !dbPath || dbPath === ':memory:' ||
      typeof now !== 'function' || typeof pureMode !== 'boolean') {
    throw new TypeError('Durable request database path required');
  }
  const handoffTable = pureMode ? 'pure_move_intents' : 'handoff_intents';
  const completionTable = pureMode ? 'pure_move_completion_checks' : 'completion_checks';
  const db = new DatabaseSync(dbPath, { timeout: 5_000 });
  try {
    for (const table of ['requests', 'request_targets', 'acquisition_attempts',
      'acquisition_starts', 'acquisition_target_claims', 'acquisition_rejections',
      'acquisition_releases', 'acquisition_retirements', handoffTable]) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
        throw new TypeError('Request progress ledgers must be initialized first');
      }
    }
  } catch (error) { db.close(); throw error; }
  const request = db.prepare(`SELECT r.id,COUNT(rt.target_id) AS target_count
    FROM requests r LEFT JOIN request_targets rt ON rt.request_id=r.id
    WHERE r.id=? GROUP BY r.id`);
  // Aggregate current ownership in SQL. Retained retries remain in the journal,
  // but neither an old-history prefix nor an arbitrary active-row cap hides work.
  const attempts = db.prepare(`WITH active_attempts AS (
    SELECT a.id AS attempt_id,a.status,
      (SELECT COUNT(*) FROM acquisition_target_claims c
        WHERE c.attempt_id=a.id AND c.active=1) AS claimed_count,
      s.status AS start_status,h.status AS handoff_status,
      EXISTS(SELECT 1 FROM acquisition_target_claims c
        WHERE c.attempt_id=a.id AND c.active=1 AND
          c.episode_id NOT IN (SELECT value FROM json_each(?))) AS pending
    FROM acquisition_attempts a
    LEFT JOIN acquisition_starts s ON s.attempt_id=a.id
    LEFT JOIN ${handoffTable} h ON h.attempt_id=a.id
    LEFT JOIN acquisition_rejections j ON j.attempt_id=a.id
    LEFT JOIN acquisition_releases x ON x.attempt_id=a.id
    LEFT JOIN acquisition_retirements t ON t.attempt_id=a.id
    WHERE a.request_id=? AND j.attempt_id IS NULL AND x.attempt_id IS NULL
      AND t.attempt_id IS NULL AND EXISTS(SELECT 1
        FROM acquisition_target_claims c WHERE c.attempt_id=a.id AND c.active=1)
  ) SELECT COUNT(*) AS active_count,
    COALESCE(SUM(CASE WHEN handoff_status IS NOT NULL THEN claimed_count ELSE 0 END),0) AS private_targets,
    COALESCE(SUM(CASE WHEN pending AND handoff_status IS NOT NULL THEN claimed_count ELSE 0 END),0) AS pending_private_targets,
    COALESCE(SUM(pending),0) AS pending_count,
    COALESCE(MAX(pending AND handoff_status<>'prepared'),0) AS pending_published,
    COALESCE(MAX(pending AND start_status IS NOT NULL),0) AS pending_started,
    COALESCE(MAX(pending AND status='torrent_observed'),0) AS pending_observed,
    COALESCE(MAX(pending AND status='dispatch_unknown'),0) AS pending_dispatch,
    MAX(CASE WHEN pending AND start_status IS NOT NULL THEN attempt_id END) AS latest_started
    FROM active_attempts`);
  const unresolvedRejections = db.prepare(`SELECT 1 FROM acquisition_attempts a
    JOIN acquisition_rejections j ON j.attempt_id=a.id
    LEFT JOIN acquisition_retirements t ON t.attempt_id=a.id
    WHERE a.request_id=? AND t.attempt_id IS NULL LIMIT 1`);
  const hasAcquisitionChecks = db.prepare(`SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='acquisition_request_checks'`);
  const hasSuspensions = db.prepare(`SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='acquisition_request_suspensions'`);
  const hasCompletionChecks = db.prepare(`SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='${completionTable}'`);
  let interruptedRequest;
  let recoveryHoldColumn = false;
  let scheduledRetry;
  let inconclusiveFileCheck;
  let transferCheck;
  let activeCompletionCheck;
  let activeRequestCheck;
  const authRetryReason = (reason) => ['provider_http_403',
    'authentication_backoff', 'authentication_unavailable'].includes(reason);
  let suspensionCheck;
  const waitingForOwner = (requestId) => {
    // Acquisition can be enabled after this read-only progress connection
    // opens, so discover the optional table on each read until it exists.
    if (!suspensionCheck) {
      if (!hasSuspensions.get()) return false;
      suspensionCheck = db.prepare(`SELECT 1
        FROM acquisition_request_suspensions WHERE request_id=?`);
    }
    return Boolean(suspensionCheck.get(requestId));
  };
  const recentTransfer = (requestId) => {
    if (!transferCheck) {
      if (!hasCompletionChecks.get() ||
          !db.prepare(`PRAGMA table_info(${completionTable})`).all()
            .some((column) => column.name === 'progress_bp')) return null;
      transferCheck = db.prepare(`SELECT c.progress_bp AS progressBasisPoints,
          c.eta_sec AS etaSeconds,c.speed_bps AS speedBytesPerSecond,
          c.transfer_state AS transferState,
          c.checked_ms AS observedMs
        FROM ${completionTable} c
        JOIN acquisition_attempts a ON a.id=c.attempt_id
        JOIN acquisition_starts s ON s.attempt_id=a.id
        LEFT JOIN ${handoffTable} h ON h.attempt_id=a.id
        LEFT JOIN acquisition_rejections j ON j.attempt_id=a.id
        LEFT JOIN acquisition_retirements t ON t.attempt_id=a.id
        LEFT JOIN acquisition_releases x ON x.attempt_id=a.id
        LEFT JOIN acquisition_stall_retirement_intents si ON si.attempt_id=a.id
        WHERE a.request_id=? AND a.status='torrent_observed'
          AND c.state='held' AND c.reason='incomplete'
          AND c.progress_bp IS NOT NULL
          AND c.checked_ms>? AND c.checked_ms<=?
          AND h.attempt_id IS NULL AND j.attempt_id IS NULL
          AND t.attempt_id IS NULL AND x.attempt_id IS NULL
          AND si.attempt_id IS NULL
          AND EXISTS (SELECT 1 FROM acquisition_target_claims live
            WHERE live.attempt_id=a.id AND live.active=1)
        ORDER BY c.checked_ms DESC,a.id DESC LIMIT 1`);
    }
    const checkedMs = now();
    if (!Number.isSafeInteger(checkedMs) || checkedMs < 0) return null;
    const row = transferCheck.get(requestId, checkedMs - 15 * 60_000,
      checkedMs);
    return row ? { ...row } : null;
  };
  const fileIdentityState = (requestId) => {
    if (!inconclusiveFileCheck) {
      if (!hasCompletionChecks.get()) return null;
      inconclusiveFileCheck = db.prepare(`SELECT COUNT(*) AS count,COALESCE(MAX(si.attempt_id IS NULL),0) AS retrying
        FROM ${completionTable} c
        JOIN acquisition_attempts a ON a.id=c.attempt_id
        JOIN acquisition_starts s ON s.attempt_id=a.id
        LEFT JOIN ${handoffTable} h ON h.attempt_id=a.id
        LEFT JOIN acquisition_rejections j ON j.attempt_id=a.id
        LEFT JOIN acquisition_retirements t ON t.attempt_id=a.id
        LEFT JOIN acquisition_releases x ON x.attempt_id=a.id
        LEFT JOIN acquisition_stall_retirement_intents si ON si.attempt_id=a.id
        WHERE a.request_id=? AND a.status='torrent_observed'
          AND c.state='held' AND c.reason='file_lookup_inconclusive'
          AND c.next_due_ms IS NOT NULL AND h.attempt_id IS NULL
          AND j.attempt_id IS NULL AND t.attempt_id IS NULL
          AND x.attempt_id IS NULL AND EXISTS (SELECT 1 FROM acquisition_target_claims live
            WHERE live.attempt_id=a.id AND live.active=1)`);
    }
    const result = inconclusiveFileCheck.get(requestId);
    return result.count > 0 ? result.retrying ? 'retrying' : 'retiring' : null;
  };
  const retryScheduled = (requestId) => {
    if (!scheduledRetry) {
      if (!hasAcquisitionChecks.get()) return false;
      scheduledRetry = db.prepare(`SELECT 1 FROM acquisition_request_checks
        WHERE request_id=? AND state='held' AND next_due_ms IS NOT NULL`);
    }
    return Boolean(scheduledRetry.get(requestId));
  };
  const interrupted = (requestId) => {
    if (!interruptedRequest || !recoveryHoldColumn) {
      if (!hasAcquisitionChecks.get()) return false;
      recoveryHoldColumn = db.prepare('PRAGMA table_info(acquisition_request_checks)').all()
        .some(column => column.name === 'recovery_hold');
      // Disabled acquisition may never open/migrate its queue. Derive the
      // old masked warning read-only from a durable unknown dispatch; do not
      // mistake a live unfinished claim or unsent reservation for recovery.
      const recovery = recoveryHoldColumn ? 'recovery_hold=1' : `state IS NOT NULL AND EXISTS (
        SELECT 1 FROM requests r WHERE r.id=acquisition_request_checks.request_id
          AND r.status='held' AND r.cancelled_ms IS NULL) AND EXISTS (
        SELECT 1 FROM acquisition_attempts a WHERE a.request_id=acquisition_request_checks.request_id
          AND a.status='dispatch_unknown' AND ${pendingRecognitionSql(db, 'a')}
          AND NOT EXISTS (SELECT 1 FROM acquisition_releases x WHERE x.attempt_id=a.id)
          AND NOT EXISTS (SELECT 1 FROM acquisition_retirements t WHERE t.attempt_id=a.id)
          AND NOT EXISTS (SELECT 1 FROM acquisition_rejections j WHERE j.attempt_id=a.id))`;
      interruptedRequest = db.prepare(`SELECT 1 FROM acquisition_request_checks
        WHERE request_id=? AND ((state='held' AND reason='interrupted_attempt_present') OR (${recovery}))
          AND NOT (EXISTS (SELECT 1 FROM acquisition_attempts a
              WHERE a.request_id=acquisition_request_checks.request_id)
            AND NOT EXISTS (SELECT 1 FROM acquisition_attempts a
              WHERE a.request_id=acquisition_request_checks.request_id
                AND ${unreconciledAttemptSql(db, 'a')}))`);
    }
    return Boolean(interruptedRequest.get(requestId));
  };
  const completedOnce = createRequestCompletionReader(db);
  return {
    read(requestId, { availableEpisodeIds = [] } = {}) {
      if (!Number.isSafeInteger(requestId) || requestId < 1) {
        throw new TypeError('Invalid request ID');
      }
      if(!Array.isArray(availableEpisodeIds)||availableEpisodeIds.some(id=>!Number.isSafeInteger(id)||id<1))throw new TypeError('Invalid available episode IDs');
      const available=new Set(availableEpisodeIds);
      const item = request.get(requestId);
      if (!item) return null;
      const summary = attempts.get(JSON.stringify([...available]),requestId);
      const privateVerifiedTargets = summary.private_targets;
      const pendingPrivateTargets = summary.pending_private_targets;
      const interruptedCheck = interrupted(requestId);
      const rejectedNeedsReview = Boolean(unresolvedRejections.get(requestId));
      const ownerReviewPending = waitingForOwner(requestId);
      const reviewRequired = ownerReviewPending || interruptedCheck ||
        rejectedNeedsReview;
      const identityState = summary.pending_started
        ? fileIdentityState(requestId) : null;
      let state = 'saved';
      if (rejectedNeedsReview) state = 'review_needed';
      else if (interruptedCheck) state = 'request_interrupted';
      else if (ownerReviewPending) state = 'owner_review_pending';
      else if (pendingPrivateTargets > 0) {
        state = privateVerifiedTargets >= item.target_count &&
          summary.pending_published
          ? 'import_unverified' :
          privateVerifiedTargets >= item.target_count
            ? 'private_copy_recorded' : 'partial_private_copy';
      } else if (summary.pending_started) {
        state = identityState === 'retrying' ? 'release_identity_unverified' :
          identityState === 'retiring' ? 'release_retirement_pending' :
            'download_unverified';
      }
      else if (summary.pending_observed) {
        state = 'torrent_stopped';
      } else if (summary.pending_dispatch) {
        state = retryScheduled(requestId)
          ? 'release_check_retrying' : 'torrent_unverified';
      } else if (summary.pending_count > 0) state = 'release_preparing';
      const transfer = summary.pending_count>0?recentTransfer(requestId):null;
      let connectionRetrying = false;
      let completionRetrying = false;
      let completionChecking = false;
      const latestStarted = summary.latest_started === null ? null :
        { attempt_id: summary.latest_started };
      if (latestStarted && hasCompletionChecks.get()) {
        activeCompletionCheck ??= db.prepare(`SELECT state,reason
          FROM ${completionTable} WHERE attempt_id=?`);
        const check = activeCompletionCheck.get(latestStarted.attempt_id);
        completionRetrying = check?.reason === 'interrupted_retry';
        completionChecking = check?.state === null;
        connectionRetrying = authRetryReason(check?.reason);
      }
      if (!completionRetrying && !completionChecking &&
          !connectionRetrying && hasAcquisitionChecks.get()) {
        activeRequestCheck ??= db.prepare(`SELECT reason FROM acquisition_request_checks
          WHERE request_id=? AND state='held'`);
        connectionRetrying = authRetryReason(activeRequestCheck.get(requestId)?.reason);
      }
      return { state, targetCount: item.target_count,
        privateVerifiedTargets, activeAttempts: summary.active_count,
        reviewRequired, publicAvailability: 'unverified',
        ...(state==='saved'&&available.size<item.target_count&&hasAcquisitionChecks.get()&&
          ['no_safe_release','no_release_candidates'].includes(activeRequestCheck?.get(requestId)?.reason)?{waitingForRelease:true}:{}),
        ...(transfer ? { transfer } : {}),
        ...(connectionRetrying ? { connectionRetrying } : {}),
        ...(completionRetrying ? { completionRetrying } : {}),
        ...(completionChecking ? { completionChecking } : {}),
        ...(state === 'partial_private_copy' && identityState === 'retrying'
          ? { identityCheckPending: true } : {}),
        ...(state === 'partial_private_copy' && identityState === 'retiring'
          ? { identityRetirementPending: true } : {}),
        ...(completedOnce(requestId) ? { oneTimeAcquisitionComplete: true } : {}) };
    },
    close() { db.close(); },
  };
}
