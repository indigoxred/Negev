// Call inside the caller's write transaction. Keep allocation history after
// rows are deleted, so a stale worker cannot address a newly reused identity.
const tables = new Set(['users', 'requests', 'acquisition_attempts']);
export function rememberIdFloor(db, table) {
  if (!tables.has(table)) throw new TypeError('Invalid durable ID table');
  db.exec(`CREATE TABLE IF NOT EXISTS durable_id_counters (
    table_name TEXT PRIMARY KEY, last_id INTEGER NOT NULL CHECK(last_id>=0)
  ) STRICT`);
  let floor = db.prepare(`SELECT COALESCE(MAX(id),0) n FROM ${table}`).get().n;
  if (table === 'users') {
    // Older versions may already have removed a user but retained ownership.
    for (const [name, column] of [['requests', 'requester_id'],
      ['pending_title_intents', 'requester_id'], ['parent_watches', 'requester_id']]) {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)) {
        floor = Math.max(floor, db.prepare(`SELECT COALESCE(MAX(${column}),0) n FROM ${name}`).get().n);
      }
    }
  }
  if (!Number.isSafeInteger(floor) || floor < 0) throw new RangeError('Account or work ID is out of range');
  db.prepare(`INSERT INTO durable_id_counters VALUES (?,?) ON CONFLICT(table_name)
    DO UPDATE SET last_id=MAX(last_id,excluded.last_id)`).run(table, floor);
  return db.prepare('SELECT last_id FROM durable_id_counters WHERE table_name=?').get(table).last_id;
}

export function allocateDurableId(db, table) {
  const id = rememberIdFloor(db, table) + 1;
  if (!Number.isSafeInteger(id)) throw new RangeError('Account or work IDs exhausted');
  db.prepare('UPDATE durable_id_counters SET last_id=? WHERE table_name=?').run(id, table);
  return id;
}
