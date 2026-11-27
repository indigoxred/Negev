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
