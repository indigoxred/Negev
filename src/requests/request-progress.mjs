import { DatabaseSync } from 'node:sqlite';

// Read-only journal summary for a request page. It never infers Plex playback
// from a torrent, a Shoko import intent, or a private handoff record.
export function openRequestProgress(dbPath) {
  if (typeof dbPath !== 'string' || !dbPath || dbPath === ':memory:') {
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
    FROM requests r JOIN request_targets rt ON rt.request_id=r.id
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
      const reviewRequired = rows.some((row) => row.rejected_id && !row.retired_id);
      let state = 'saved';
      if (reviewRequired) state = 'review_needed';
      else if (privateVerifiedTargets > 0) {
        state = privateVerifiedTargets >= item.target_count &&
          active.some((row) => row.handoff_status !== 'prepared')
          ? 'import_unverified' :
          privateVerifiedTargets >= item.target_count
            ? 'private_copy_recorded' : 'partial_private_copy';
      } else if (active.some((row) => row.start_status)) state = 'download_unverified';
      else if (active.some((row) => row.status === 'torrent_observed')) {
        state = 'torrent_stopped';
      } else if (active.some((row) => row.status === 'dispatch_unknown')) {
        state = 'torrent_unverified';
      } else if (active.length > 0) state = 'release_preparing';
      return { state, targetCount: item.target_count,
        privateVerifiedTargets, activeAttempts: active.length,
        reviewRequired, publicAvailability: 'unverified' };
    },
    close() { db.close(); },
  };
}
