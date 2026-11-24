import { DatabaseSync } from 'node:sqlite';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const safeReasons = new Set(['provider_unavailable', 'provider_http_error', 'provider_timeout',
  'provider_transport', 'provider_invalid_response', 'no_safe_release', 'no_release_candidates',
  'preferred_group_wait', 'shoko_metadata_missing', 'import_activity_unverified',
  'availability_evidence_stale', 'torrent_incomplete', 'torrent_unavailable',
  'identity_unavailable', 'subtitle_unavailable', 'mount_changed', 'staging_root_unverified',
  'interrupted_attempt_present', 'interrupted_before_publish', 'move_outcome_unknown',
  'start_outcome_unknown', 'shoko_rescan_pending', 'request_inflight']);

// Explicit operator invocation only. No provider calls, migrations, timer,
// mutations or HTTP readiness claim. Directory access is the auth boundary.
export async function readWorkerDiagnostics({ dataDir, nowMs = Date.now() } = {}) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) ||
      path.normalize(dataDir) !== dataDir || !Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new TypeError('Private data directory and current time required');
  }
  const dbPath = path.join(dataDir, 'negev.sqlite');
  const [directory, file] = await Promise.all([lstat(dataDir), lstat(dbPath)]);
  if (!directory.isDirectory() || directory.isSymbolicLink() ||
      !file.isFile() || file.isSymbolicLink() || path.relative(dataDir, await realpath(dataDir)) !== '' ||
      (process.platform !== 'win32' && (directory.mode & 0o077) !== 0)) {
    throw new TypeError('Restricted canonical data directory required');
  }
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5_000 });
  try {
    db.exec('PRAGMA query_only=ON');
    db.exec('BEGIN');
    const exists = table => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
    const stages = {};
    for (const [name, table] of [
      ['acquisition', 'acquisition_request_checks'], ['start', 'start_checks'],
      ['completion', 'completion_checks'], ['pureCompletion', 'pure_move_completion_checks'],
      ['publish', 'handoff_publish_checks'], ['purePublish', 'pure_move_publish_checks'],
    ]) {
      if (!exists(table)) { stages[name] = { state: 'not_initialized' }; continue; }
      const value = db.prepare(`SELECT COUNT(*) AS recorded,
        COALESCE(SUM(state IS NULL),0) AS unresolvedClaims,
        COALESCE(SUM(state IS NOT NULL AND next_due_ms<=?),0) AS dueRetries,
        MIN(CASE WHEN state IS NOT NULL AND next_due_ms<=? THEN next_due_ms END) AS oldestDueMs,
        MAX(CASE WHEN state IN ('stopped_observed','handoff_prepared','published_observed','observed')
          THEN checked_ms END) AS lastSuccessfulMs
        FROM ${table}`).get(nowMs, nowMs);
      const reasons = db.prepare(`SELECT reason,COUNT(*) AS count FROM ${table}
        WHERE state='held' GROUP BY reason ORDER BY count DESC LIMIT 8`).all()
        .map(row => ({ reason: safeReasons.has(row.reason) ? row.reason : 'other', count: row.count }));
      const { oldestDueMs, ...counts } = value;
      stages[name] = { state: 'snapshot', ...counts,
        oldestDueAgeMs: oldestDueMs === null ? null : nowMs - oldestDueMs, reasons };
    }
    const plex = exists('plex_card_cursors') ? { cursors: db.prepare(
      'SELECT kind,offset FROM plex_card_cursors ORDER BY library_id,kind LIMIT 20').all().map(row => ({ ...row })) } : null;
    if (plex && exists('plex_card_retries')) plex.retries = { ...db.prepare(
      'SELECT COUNT(*) AS pending,COALESCE(SUM(due_ms<=?),0) AS due FROM plex_card_retries').get(nowMs) };
    const recent = exists('shoko_recent_pending') ? { ...db.prepare(
      'SELECT COUNT(*) AS pending,COALESCE(SUM(retry_after_ms<=?),0) AS due FROM shoko_recent_pending').get(nowMs) } : null;
    if (recent && exists('shoko_recent_continuation')) recent.continuations = db.prepare(
      'SELECT COUNT(*) AS count FROM shoko_recent_continuation').get().count;
    const inventory = exists('shoko_inventory_cursor') ? db.prepare(
      'SELECT page,pass FROM shoko_inventory_cursor LIMIT 1').get() ?? null : null;
    db.exec('COMMIT');
    return { state: 'worker_snapshot', observedMs: nowMs, readiness: 'not_established',
      stages, plex, recent, inventory: inventory && { ...inventory } };
  } finally { db.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await readWorkerDiagnostics({ dataDir: process.env.NEGEV_DATA_DIR });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write('Worker diagnostics unavailable; verify private directory access and database schema.\n');
    process.exitCode = 1;
  }
}
