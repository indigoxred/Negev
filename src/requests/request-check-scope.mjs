// All consumers use aliases r (request) and c (acquisition check). Keep the
// canonical target order identical to the queue's durable claim snapshot.
export const currentRequestScopeSql = `(SELECT json_group_array(json_array(anidb_id,episode_id))
  FROM (SELECT t.anidb_id,t.episode_id FROM request_targets rt
    JOIN targets t ON t.id=rt.target_id WHERE rt.request_id=r.id
    ORDER BY t.episode_id,t.anidb_id))`;

export const changedRequestScopeSql = `(c.scan_targets_json IS NOT NULL AND
  c.scan_targets_json<>${currentRequestScopeSql} OR
  c.reason='request_fully_available' AND c.scan_targets_json IS NULL)`;

export const currentRequestCompletionSql = `(c.state='held' AND
  c.reason='request_fully_available' AND c.scan_targets_json IS NOT NULL AND
  c.scan_targets_json=${currentRequestScopeSql})`;

// Ordinary choice writes advance the revision and retain a non-NULL control.
// This is positive untouched-Auto provenance, not just a current Auto label.
// A caller must still require an exact unchanged checked target scope.
export const untouchedAutoSql = `(r.release_control IS NULL AND c.checked_release_revision=0)`;
