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
          AND ${currentRequestCompletionSql}`);
      return Boolean(modern.get(requestId));
    }
    if (!names.has('scan_scope')) return false;
    legacy ??= db.prepare(`SELECT c.scan_scope,r.release_control,
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
    // Before the full-scope processor policy, a chosen subset could produce
    // the same completion reason even though the claim hash covered all
    // targets. Match the queue's conservative legacy-subset repair boundary.
    if (row.scope_policy < 1) {
      let control;
      try { control = JSON.parse(row.release_control); } catch { /* No retained choice. */ }
      const selected = control?.selection?.preview?.episodeIds;
      const episodeIds = new Set(targets.map(target => target.episode_id));
      if (['chosen', 'consumed'].includes(control?.phase) &&
          Array.isArray(selected) && selected.length > 0 &&
          selected.every(id => Number.isSafeInteger(id) && id > 0) &&
          new Set(selected).size === selected.length &&
          selected.length < episodeIds.size && selected.every(id => episodeIds.has(id))) {
        return false;
      }
    }
    return targets.length > 0 && createHash('sha256')
      .update(JSON.stringify(targets)).digest('hex') === row.scan_scope;
  };
}
