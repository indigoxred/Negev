import { createHash } from 'node:crypto';
import { currentRequestCompletionSql, currentRequestScopeSql } from './request-check-scope.mjs';

// Historical completion is not fresh public availability. Read old scope
// evidence without opening the acquisition queue or migrating its tables.
export function createRequestCompletionReader(db) {
  let modern;
  let legacy;
  const columns = db.prepare('PRAGMA table_info(acquisition_request_checks)');
  return requestId => {
    if (modern) return Boolean(modern.get(requestId));
    // Keep discovering until the optional queue exists or migrates later.
    const names = new Set(columns.all().map(column => column.name));
    if (names.has('scan_targets_json')) {
      modern = db.prepare(`SELECT 1 FROM requests r
        JOIN acquisition_request_checks c ON c.request_id=r.id
        WHERE r.id=? AND (r.monitor_future=0 OR r.watch_closed=1)
          AND ${currentRequestCompletionSql}
          AND (json_array_length(c.scan_targets_json)<=1 OR ${names.has('request_scope_policy_revision') ? 'c.request_scope_policy_revision' : '0'}>=2)`);
      return Boolean(modern.get(requestId));
    }
    if (!names.has('scan_scope')) return false;
    legacy ??= db.prepare(`SELECT c.scan_scope,
        ${names.has('request_scope_policy_revision') ? 'c.request_scope_policy_revision' : '0'} AS scope_policy,
        ${currentRequestScopeSql} AS targets_json
      FROM requests r JOIN acquisition_request_checks c ON c.request_id=r.id
      WHERE r.id=? AND (r.monitor_future=0 OR r.watch_closed=1)
        AND c.state='held' AND c.reason='request_fully_available'
        AND c.scan_scope IS NOT NULL`);
    const row = legacy.get(requestId);
    if (!row) return false;
    // The queue's pre-snapshot writer hashed ordered objects, not the modern
    // tuple JSON. Read scope and check in one SQL snapshot to avoid accepting
    // a completion against a separately read, concurrently expanded request.
    const targets = JSON.parse(row.targets_json).map(([anidb_id, episode_id]) =>
      ({ anidb_id, episode_id }));
    // A legacy full-target claim hash does not prove what the old processor
    // checked. Revision 1 can be only an upgrade stamp, and choices can have
    // changed since the check. Only a corrected worker earns revision 2.
    if (targets.length > 1 && row.scope_policy < 2) return false;
    return targets.length > 0 && createHash('sha256')
      .update(JSON.stringify(targets)).digest('hex') === row.scan_scope;
  };
}
