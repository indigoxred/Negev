// One definition of "this attempt still belongs to a live request and has not
// ended". An attempt has ended once it is released, rejected, retired, or is
// being retired. A suspended request is paused, not ended, so each queue
// still applies its own suspension rule.
//
// This is a shared SQL subquery, deliberately not a database VIEW: a view
// that names these tables would make SQLite refuse the ledgers' table-rebuild
// migrations (DROP TABLE + RENAME), now and after a rollback. Use it as
//   FROM ${LIVE_ATTEMPTS} a
export const LIVE_ATTEMPTS = `(SELECT a.* FROM acquisition_attempts a
  JOIN requests r ON r.id=a.request_id AND r.status='held' AND r.cancelled_ms IS NULL
  WHERE NOT EXISTS (SELECT 1 FROM acquisition_releases x WHERE x.attempt_id=a.id)
    AND NOT EXISTS (SELECT 1 FROM acquisition_rejections x WHERE x.attempt_id=a.id)
    AND NOT EXISTS (SELECT 1 FROM acquisition_retirements x WHERE x.attempt_id=a.id)
    AND NOT EXISTS (SELECT 1 FROM acquisition_stall_retirement_intents x
      WHERE x.attempt_id=a.id))`;
