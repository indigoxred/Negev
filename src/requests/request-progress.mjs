import { DatabaseSync } from 'node:sqlite';

// Read-only journal summary for a request page. It never infers Plex playback
// from a torrent, a Shoko import intent, or a private handoff record.
export function openRequestProgress(dbPath, { now = Date.now } = {}) {
  if (typeof dbPath !== 'string' || !dbPath || dbPath === ':memory:' ||
      typeof now !== 'function') {
    throw new TypeError('Durable request database path required');
  }
  const db = new DatabaseSync(dbPath, { timeout: 5_000 });
  try {
    for (const table of ['requests', 'request_targets', 'acquisition_attempts',
      'acquisition_starts', 'acquisition_target_claims', 'acquisition_rejections',
      'acquisition_releases', 'acquisition_retirements', 'handoff_intents']) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
        throw new TypeError('Request progress ledgers must be initialized first');
      }
    }
  } catch (error) { db.close(); throw error; }
  const request = db.prepare(`SELECT r.id,COUNT(rt.target_id) AS target_count
    FROM requests r LEFT JOIN request_targets rt ON rt.request_id=r.id
    WHERE r.id=? GROUP BY r.id`);
  const attempts = db.prepare(`SELECT a.status,
      (SELECT COUNT(*) FROM acquisition_target_claims c
        WHERE c.attempt_id=a.id AND c.active=1) AS claimed_count,
      s.status AS start_status,h.status AS handoff_status,
      j.attempt_id AS rejected_id,x.attempt_id AS released_id,
      t.attempt_id AS retired_id
    FROM acquisition_attempts a
    LEFT JOIN acquisition_starts s ON s.attempt_id=a.id
    LEFT JOIN handoff_intents h ON h.attempt_id=a.id
    LEFT JOIN acquisition_rejections j ON j.attempt_id=a.id
    LEFT JOIN acquisition_releases x ON x.attempt_id=a.id
    LEFT JOIN acquisition_retirements t ON t.attempt_id=a.id
    WHERE a.request_id=? ORDER BY a.id LIMIT 101`);
  const hasAcquisitionChecks = db.prepare(`SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='acquisition_request_checks'`);
  const hasSuspensions = db.prepare(`SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='acquisition_request_suspensions'`);
  const hasCompletionChecks = db.prepare(`SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='completion_checks'`);
  let oneTimeCompletion;
  let interruptedRequest;
  let scheduledRetry;
  let inconclusiveFileCheck;
  let transferCheck;
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
          !db.prepare('PRAGMA table_info(completion_checks)').all()
            .some((column) => column.name === 'progress_bp')) return null;
      transferCheck = db.prepare(`SELECT c.progress_bp AS progressBasisPoints,
          c.eta_sec AS etaSeconds,c.speed_bps AS speedBytesPerSecond,
          c.transfer_state AS transferState,
          c.checked_ms AS observedMs
        FROM completion_checks c
        JOIN acquisition_attempts a ON a.id=c.attempt_id
        JOIN acquisition_starts s ON s.attempt_id=a.id
        LEFT JOIN handoff_intents h ON h.attempt_id=a.id
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
      inconclusiveFileCheck = db.prepare(`SELECT si.attempt_id AS retirement_id
        FROM completion_checks c
        JOIN acquisition_attempts a ON a.id=c.attempt_id
        JOIN acquisition_starts s ON s.attempt_id=a.id
        LEFT JOIN handoff_intents h ON h.attempt_id=a.id
        LEFT JOIN acquisition_rejections j ON j.attempt_id=a.id
        LEFT JOIN acquisition_retirements t ON t.attempt_id=a.id
        LEFT JOIN acquisition_releases x ON x.attempt_id=a.id
        LEFT JOIN acquisition_stall_retirement_intents si ON si.attempt_id=a.id
        WHERE a.request_id=? AND a.status='torrent_observed'
          AND c.state='held' AND c.reason='file_lookup_inconclusive'
          AND c.next_due_ms IS NOT NULL AND h.attempt_id IS NULL
          AND j.attempt_id IS NULL AND t.attempt_id IS NULL
          AND x.attempt_id IS NULL LIMIT 101`);
    }
    const rows = inconclusiveFileCheck.all(requestId);
    if (rows.length > 100) return null;
    if (rows.some((row) => row.retirement_id === null)) return 'retrying';
    return rows.length > 0 ? 'retiring' : null;
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
    if (!interruptedRequest) {
      if (!hasAcquisitionChecks.get()) return false;
      interruptedRequest = db.prepare(`SELECT 1 FROM acquisition_request_checks
        WHERE request_id=? AND state='held'
          AND reason='interrupted_attempt_present'`);
    }
    return Boolean(interruptedRequest.get(requestId));
  };
  const completedOnce = (requestId) => {
    // Acquisition is opt-in and its queue may open after this reader.
    if (!oneTimeCompletion) {
      if (!hasAcquisitionChecks.get()) return false;
      oneTimeCompletion = db.prepare(`SELECT 1 FROM requests r
        JOIN acquisition_request_checks c ON c.request_id=r.id
        WHERE r.id=? AND (r.monitor_future=0 OR r.watch_closed=1)
          AND c.state='held' AND c.reason='request_fully_available'`);
    }
    return Boolean(oneTimeCompletion.get(requestId));
  };
  return {
    read(requestId) {
      if (!Number.isSafeInteger(requestId) || requestId < 1) {
        throw new TypeError('Invalid request ID');
      }
      const item = request.get(requestId);
      if (!item) return null;
      const rows = attempts.all(requestId);
      if (rows.length > 100) return { state: 'unknown',
        reason: 'too_many_attempts', publicAvailability: 'unverified' };
      const active = rows.filter((row) => !row.released_id && !row.retired_id &&
        !row.rejected_id);
      const privateVerifiedTargets = active.reduce((sum, row) =>
        sum + (row.handoff_status ? row.claimed_count : 0), 0);
      const interruptedCheck = interrupted(requestId);
      const rejectedNeedsReview = rows.some((row) => row.rejected_id && !row.retired_id);
      const ownerReviewPending = waitingForOwner(requestId);
      const reviewRequired = ownerReviewPending || interruptedCheck ||
        rejectedNeedsReview;
      const identityState = active.some((row) => row.start_status)
        ? fileIdentityState(requestId) : null;
      let state = 'saved';
      if (rejectedNeedsReview) state = 'review_needed';
      else if (interruptedCheck) state = 'request_interrupted';
      else if (ownerReviewPending) state = 'owner_review_pending';
      else if (privateVerifiedTargets > 0) {
        state = privateVerifiedTargets >= item.target_count &&
          active.some((row) => row.handoff_status !== 'prepared')
          ? 'import_unverified' :
          privateVerifiedTargets >= item.target_count
            ? 'private_copy_recorded' : 'partial_private_copy';
      } else if (active.some((row) => row.start_status)) {
        state = identityState === 'retrying' ? 'release_identity_unverified' :
          identityState === 'retiring' ? 'release_retirement_pending' :
            'download_unverified';
      }
      else if (active.some((row) => row.status === 'torrent_observed')) {
        state = 'torrent_stopped';
      } else if (active.some((row) => row.status === 'dispatch_unknown')) {
        state = retryScheduled(requestId)
          ? 'release_check_retrying' : 'torrent_unverified';
      } else if (active.length > 0) state = 'release_preparing';
      const transfer = recentTransfer(requestId);
      return { state, targetCount: item.target_count,
        privateVerifiedTargets, activeAttempts: active.length,
        reviewRequired, publicAvailability: 'unverified',
        ...(transfer ? { transfer } : {}),
        ...(state === 'partial_private_copy' && identityState === 'retrying'
          ? { identityCheckPending: true } : {}),
        ...(state === 'partial_private_copy' && identityState === 'retiring'
          ? { identityRetirementPending: true } : {}),
        ...(completedOnce(requestId) ? { oneTimeAcquisitionComplete: true } : {}) };
    },
    close() { db.close(); },
  };
}
