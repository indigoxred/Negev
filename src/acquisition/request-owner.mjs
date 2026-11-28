// Historical diagnostic ledgers have no accounts. A real account database
// must have a present, enabled owner before any new external-send intent.
export function activeRequestOwnerSql(db, requestIdExpression) {
  const hasUsers = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'").get();
  return hasUsers ? `EXISTS (SELECT 1 FROM requests owner_request JOIN users owner
    ON owner.id=owner_request.requester_id WHERE owner_request.id=${requestIdExpression}
      AND owner.disabled=0)` : '1=1';
}

export function requestOwnerActive(db, requestId) {
  const condition = activeRequestOwnerSql(db, '?');
  return condition === '1=1' || Boolean(db.prepare(`SELECT 1 WHERE ${condition}`).get(requestId));
}

// Called in the same transaction that records each new external-send intent.
// The caller supplies classification from its fresh server-side read; absence
// of a flag cannot authorize an adult-blocked owner. Old diagnostic databases
// without accounts retain their existing isolated-ledger behavior.
export function requestAccessHold(db, requestId, restricted) {
  if (!requestOwnerActive(db, requestId)) return 'account_access_changed';
  const columns = db.prepare('PRAGMA table_info(users)').all();
  if (columns.length === 0) return null;
  const owner = columns.some(column => column.name === 'adult_allowed')
    ? db.prepare(`SELECT u.adult_allowed FROM requests r
      JOIN users u ON u.id=r.requester_id WHERE r.id=?`).get(requestId) : null;
  if (owner?.adult_allowed === 1) return null;
  return restricted === false ? null : restricted === true
    ? 'adult_access_disabled' : 'restricted_or_unverified';
}
