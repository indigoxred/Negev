import { DatabaseSync } from 'node:sqlite';

const held = (reason) => ({ state: 'held', reason });
const validId = (value) => Number.isSafeInteger(value) && value > 0;
const validItem = (item) => {
  if (!validId(item?.fileId) || typeof item.updated !== 'string' ||
      !Number.isFinite(Date.parse(item.updated)) ||
      !['provisional', 'linked', 'unverified'].includes(item.state) ||
      !Array.isArray(item.pairs) || item.pairs.length > 100 ||
      (item.state === 'linked') !== (item.pairs.length > 0)) return false;
  const seen = new Set();
  for (const pair of item.pairs) {
    if (!validId(pair?.anidbId) || !validId(pair?.episodeId)) return false;
    const key = `${pair.anidbId}:${pair.episodeId}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
};

// Inventory is positive discovery only. Old rows are never deleted by a
// partial pass, and they cannot by themselves establish current availability.
export function openShokoInventoryLedger(dbPath, { pageSize = 25 } = {}) {
  if (typeof dbPath !== 'string' || !dbPath || dbPath === ':memory:' ||
      !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) {
    throw new TypeError('Invalid durable Shoko inventory configuration');
  }
  const db = new DatabaseSync(dbPath, { timeout: 5_000 });
  try {
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA foreign_keys=ON');
    db.exec(`CREATE TABLE IF NOT EXISTS shoko_inventory_cursor (
      id INTEGER PRIMARY KEY CHECK(id=1),
      page INTEGER NOT NULL CHECK(page>0),
      pass INTEGER NOT NULL CHECK(pass>0),
      page_size INTEGER NOT NULL CHECK(page_size BETWEEN 1 AND 50)
    ) STRICT`);
    db.exec(`CREATE TABLE IF NOT EXISTS shoko_inventory_files (
      file_id INTEGER PRIMARY KEY CHECK(file_id>0),
      updated TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('provisional','linked','unverified')),
      pairs_json TEXT NOT NULL,
      seen_pass INTEGER NOT NULL CHECK(seen_pass>=0),
      observed_ms INTEGER NOT NULL CHECK(observed_ms>=0)
    ) STRICT`);
    db.exec(`CREATE TABLE IF NOT EXISTS shoko_inventory_pairs (
      file_id INTEGER NOT NULL REFERENCES shoko_inventory_files(file_id),
      anidb_id INTEGER NOT NULL CHECK(anidb_id>0),
      episode_id INTEGER NOT NULL CHECK(episode_id>0),
      PRIMARY KEY(file_id,anidb_id,episode_id)
    ) STRICT`);
    db.exec(`CREATE INDEX IF NOT EXISTS shoko_inventory_episode
      ON shoko_inventory_pairs(anidb_id,episode_id,file_id)`);
    db.prepare(`INSERT INTO shoko_inventory_cursor(id,page,pass,page_size)
      VALUES (1,1,1,?) ON CONFLICT(id) DO NOTHING`).run(pageSize);
    const size = db.prepare('SELECT page_size FROM shoko_inventory_cursor WHERE id=1').get()?.page_size;
    if (size !== pageSize) throw new TypeError('Shoko inventory page size changed');
  } catch (error) { db.close(); throw error; }
  const cursor = db.prepare('SELECT page,pass,page_size AS pageSize FROM shoko_inventory_cursor WHERE id=1');
  const find = db.prepare(`SELECT file_id AS fileId,updated,state,pairs_json AS pairsJson,
    seen_pass AS seenPass,observed_ms AS observedMs FROM shoko_inventory_files WHERE file_id=?`);
  const save = db.prepare(`INSERT INTO shoko_inventory_files
    (file_id,updated,state,pairs_json,seen_pass,observed_ms) VALUES (?,?,?,?,?,?)
    ON CONFLICT(file_id) DO UPDATE SET updated=excluded.updated,state=excluded.state,
      pairs_json=excluded.pairs_json,seen_pass=excluded.seen_pass,
      observed_ms=excluded.observed_ms`);
  const removePairs = db.prepare('DELETE FROM shoko_inventory_pairs WHERE file_id=?');
  const addPair = db.prepare(`INSERT INTO shoko_inventory_pairs(file_id,anidb_id,episode_id)
    VALUES (?,?,?)`);
  const findPairs = db.prepare(`SELECT file_id FROM shoko_inventory_pairs
    WHERE anidb_id=? AND episode_id=? ORDER BY file_id`);
  const advance = db.prepare(`UPDATE shoko_inventory_cursor SET page=?,pass=?
    WHERE id=1 AND page=? AND pass=?`);
  function saveObservation(item, seenPass, observedMs) {
    const previous = find.get(item.fileId);
    if (previous && (previous.observedMs > observedMs ||
        (previous.observedMs === observedMs &&
          previous.seenPass === 0 && seenPass > 0))) return;
    save.run(item.fileId, item.updated, item.state, JSON.stringify(item.pairs),
      seenPass, observedMs);
    removePairs.run(item.fileId);
    for (const pair of item.pairs) addPair.run(item.fileId, pair.anidbId, pair.episodeId);
  }
  return {
    getCursor() { return { ...cursor.get() }; },
    getFile(fileId) {
      if (!validId(fileId)) throw new TypeError('Invalid Shoko file ID');
      const row = find.get(fileId);
      if (!row) return null;
      const { pairsJson, ...other } = row;
      return { ...other, pairs: JSON.parse(pairsJson) };
    },
    getObservedFileIds({ anidbId, episodeId }) {
      if (!validId(anidbId) || !validId(episodeId)) {
        throw new TypeError('Invalid AniDB episode identity');
      }
      return findPairs.all(anidbId, episodeId).map((row) => row.file_id);
    },
    recordFileObservation({ item, observedMs }) {
      if (!validItem(item) || !Number.isSafeInteger(observedMs) || observedMs < 0) {
        return held('invalid_file_observation');
      }
      let begun = false;
      try {
        db.exec('BEGIN IMMEDIATE'); begun = true;
        saveObservation(item, 0, observedMs);
        db.exec('COMMIT'); begun = false;
        return { state: 'recorded_file', fileId: item.fileId };
      } catch (error) {
        if (begun) db.exec('ROLLBACK');
        throw error;
      }
    },
    recordPage({ expected, result, observedMs }) {
      if (!validId(expected?.page) || !validId(expected.pass) ||
          !Number.isSafeInteger(observedMs) || observedMs < 0 ||
          result?.state !== 'page' || result.page !== expected.page ||
          !Number.isSafeInteger(result.total) || result.total < 0 ||
          !Array.isArray(result.items) || result.items.length > pageSize ||
          (result.items.length === 0 && (expected.page - 1) * pageSize < result.total)) {
        return held('invalid_file_page');
      }
      const seen = new Set();
      for (const item of result.items) {
        if (!validItem(item) || seen.has(item.fileId)) {
          return held('invalid_file_page');
        }
        seen.add(item.fileId);
      }
      let begun = false;
      try {
        db.exec('BEGIN IMMEDIATE'); begun = true;
        const current = cursor.get();
        if (current.page !== expected.page || current.pass !== expected.pass) {
          db.exec('ROLLBACK'); begun = false;
          return held('stale_cursor');
        }
        for (const item of result.items) {
          saveObservation(item, current.pass, observedMs);
        }
        const last = current.page * pageSize >= result.total;
        const nextPage = last ? 1 : current.page + 1;
        const nextPass = last ? current.pass + 1 : current.pass;
        advance.run(nextPage, nextPass, current.page, current.pass);
        db.exec('COMMIT'); begun = false;
        return { state: 'recorded', page: current.page, pass: current.pass, nextPage };
      } catch (error) {
        if (begun) db.exec('ROLLBACK');
        throw error;
      }
    },
    close() { db.close(); },
  };
}

// One explicitly called tick reads at most one bounded Shoko page. There is
// no timer and no acquisition or Plex status side effect.
export function createShokoInventoryWorker({ ledger, readPage, now = Date.now,
  onChangedFile } = {}) {
  if (typeof ledger?.getCursor !== 'function' || typeof ledger?.recordPage !== 'function' ||
      typeof readPage !== 'function' || typeof now !== 'function' ||
      (onChangedFile !== undefined && typeof onChangedFile !== 'function')) {
    throw new TypeError('Invalid Shoko inventory worker');
  }
  return {
    async tick() {
      const expected = ledger.getCursor();
      // Timestamp the page before its HTTP read. A targeted event recheck
      // completed during that read must outrank this older page snapshot.
      const observedMs = now();
      let result;
      try { result = await readPage({ page: expected.page, pageSize: expected.pageSize }); }
      catch { return held('file_page_unavailable'); }
      if (result?.state !== 'page') return held('file_page_unavailable');
      const previous = onChangedFile ? result.items.map((item) =>
        ledger.getFile(item.fileId)) : [];
      const saved = ledger.recordPage({ expected, result, observedMs });
      if (saved.state === 'recorded' && onChangedFile) {
        for (let i = 0; i < result.items.length; i++) {
          const item = result.items[i];
          const current = ledger.getFile(item.fileId);
          if (current?.observedMs === observedMs &&
              (previous[i]?.updated !== current.updated ||
               previous[i]?.state !== current.state ||
               JSON.stringify(previous[i]?.pairs) !== JSON.stringify(current.pairs))) {
            onChangedFile({ before: previous[i], after: current, observedMs });
          }
        }
      }
      return saved;
    },
  };
}
