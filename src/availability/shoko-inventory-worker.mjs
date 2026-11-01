import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

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
export function openShokoInventoryLedger(dbPath, { pageSize = 100 } = {}) {
  if (typeof dbPath !== 'string' || !dbPath || dbPath === ':memory:' ||
      !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new TypeError('Invalid durable Shoko inventory configuration');
  }
  const db = new DatabaseSync(dbPath, { timeout: 5_000 });
  let activePageSize;
  try {
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA foreign_keys=ON');
    db.exec(`CREATE TABLE IF NOT EXISTS shoko_inventory_cursor (
      id INTEGER PRIMARY KEY CHECK(id=1),
      page INTEGER NOT NULL CHECK(page>0),
      pass INTEGER NOT NULL CHECK(pass>0),
      page_size INTEGER NOT NULL CHECK(page_size BETWEEN 1 AND 100),
      sort_mode TEXT NOT NULL DEFAULT 'FileID' CHECK(sort_mode='FileID')
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
    db.exec(`CREATE TABLE IF NOT EXISTS shoko_inventory_passes (
      pass INTEGER PRIMARY KEY CHECK(pass>0),
      total INTEGER NOT NULL CHECK(total>=0),
      started_ms INTEGER NOT NULL CHECK(started_ms>=0),
      seen_count INTEGER NOT NULL CHECK(seen_count>=0),
      last_file_id INTEGER NOT NULL CHECK(last_file_id>=0),
      digest TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running','complete','invalid'))
    ) STRICT`);
    db.exec(`CREATE TABLE IF NOT EXISTS shoko_file_change_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER NOT NULL CHECK(file_id>0),
      observed_ms INTEGER NOT NULL CHECK(observed_ms>=0),
      before_json TEXT,
      after_json TEXT,
      delivered INTEGER NOT NULL DEFAULT 1 CHECK(delivered IN (0,1))
    ) STRICT`);
    const changeColumns = new Set(db.prepare(
      'PRAGMA table_info(shoko_file_change_events)').all()
      .map((column) => column.name));
    for (const [name, declaration] of [
      ['before_json', 'TEXT'], ['after_json', 'TEXT'],
      ['delivered', 'INTEGER NOT NULL DEFAULT 1 CHECK(delivered IN (0,1))'],
    ]) {
      if (!changeColumns.has(name)) db.exec(`ALTER TABLE shoko_file_change_events
        ADD COLUMN ${name} ${declaration}`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS shoko_change_file
      ON shoko_file_change_events(file_id,id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS shoko_change_undelivered
      ON shoko_file_change_events(id) WHERE delivered=0`);
    db.exec(`CREATE INDEX IF NOT EXISTS shoko_inventory_episode
      ON shoko_inventory_pairs(anidb_id,episode_id,file_id)`);
    const columns = db.prepare('PRAGMA table_info(shoko_inventory_cursor)').all();
    if (!columns.some((column) => column.name === 'sort_mode')) {
      // Older cursors paged in path order. Restart their positive-only pass
      // rather than interpreting page N as page N in file-ID order.
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(`ALTER TABLE shoko_inventory_cursor ADD COLUMN
          sort_mode TEXT NOT NULL DEFAULT 'FileID' CHECK(sort_mode='FileID')`);
        db.exec('UPDATE shoko_inventory_cursor SET page=1,pass=pass+1 WHERE id=1');
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    const saved = db.prepare(`SELECT page_size AS pageSize,sort_mode AS sortMode
      FROM shoko_inventory_cursor WHERE id=1`).get();
    if (!saved) db.prepare(`INSERT INTO shoko_inventory_cursor(id,page,pass,page_size)
      VALUES (1,1,1,?)`).run(pageSize);
    const size = saved?.pageSize ?? pageSize;
    if (!Number.isSafeInteger(size) || size < 1 || size > 100) {
      throw new TypeError('Invalid saved Shoko inventory page size');
    }
    if (saved && saved.sortMode !== 'FileID') {
      throw new TypeError('Invalid saved Shoko inventory sort mode');
    }
    // Keep an older durable cursor at its original page size. Changing it
    // mid-pass would skip or repeat file IDs after a restart.
    activePageSize = size;
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
  const findPass = db.prepare(`SELECT pass,total,started_ms AS startedMs,
    seen_count AS seenCount,last_file_id AS lastFileId,digest,status
    FROM shoko_inventory_passes WHERE pass=?`);
  const startPass = db.prepare(`INSERT INTO shoko_inventory_passes
    (pass,total,started_ms,seen_count,last_file_id,digest,status)
    VALUES (?,?,?,0,0,'','running')`);
  const updatePass = db.prepare(`UPDATE shoko_inventory_passes SET
    seen_count=?,last_file_id=?,digest=?,status=? WHERE pass=?`);
  const prunePasses = db.prepare(`DELETE FROM shoko_inventory_passes
    WHERE pass<?`);
  const omitted = db.prepare(`SELECT file_id AS fileId,updated,state,
    pairs_json AS pairsJson,seen_pass AS seenPass,
    observed_ms AS observedMs FROM shoko_inventory_files
    WHERE seen_pass<? AND observed_ms<? AND state='linked'
    ORDER BY file_id LIMIT 101`);
  const saveChange = db.prepare(`INSERT INTO shoko_file_change_events
    (file_id,observed_ms,before_json,after_json,delivered)
    VALUES (?,?,?,?,0)`);
  const nextUndelivered = db.prepare(`SELECT id,observed_ms AS observedMs,
    before_json AS beforeJson,after_json AS afterJson
    FROM shoko_file_change_events WHERE delivered=0 ORDER BY id LIMIT 1`);
  const markDelivered = db.prepare(`UPDATE shoko_file_change_events SET
    delivered=1 WHERE id=? AND delivered=0`);
  let invalidateDirect = null;
  const invalidateProvenFile = (fileId, observedMs) => {
    if (!invalidateDirect) {
      const columns = new Set(db.prepare(
        'PRAGMA table_info(direct_availability_targets)').all()
        .map((column) => column.name));
      if (columns.has('proof_file_id')) {
        invalidateDirect = db.prepare(`UPDATE direct_availability_targets SET
          state='pending',due_ms=?,priority=1,version=version+1,
          verified_ms=NULL,proof_file_id=NULL,proof_library_id=NULL,
          proof_rating_key=NULL,proof_part_id=NULL
          WHERE proof_file_id=? AND state='available'`);
      }
    }
    invalidateDirect?.run(observedMs, fileId);
  };
  function saveObservation(item, seenPass, observedMs) {
    const previous = find.get(item.fileId);
    if (previous && (previous.observedMs > observedMs ||
        (previous.observedMs === observedMs &&
          previous.seenPass === 0 && seenPass > 0))) return;
    const pairsJson = JSON.stringify(item.pairs);
    if (!previous || previous.updated !== item.updated ||
        previous.state !== item.state || previous.pairsJson !== pairsJson) {
      const before = previous ? { fileId: item.fileId,
        updated: previous.updated, state: previous.state,
        pairs: JSON.parse(previous.pairsJson), seenPass: previous.seenPass,
        observedMs: previous.observedMs } : null;
      const after = { ...item, seenPass, observedMs };
      saveChange.run(item.fileId, observedMs,
        JSON.stringify(before), JSON.stringify(after));
    }
    if (previous && (previous.updated !== item.updated ||
        previous.state !== item.state || previous.pairsJson !== pairsJson)) {
      invalidateProvenFile(item.fileId, observedMs);
    }
    save.run(item.fileId, item.updated, item.state, pairsJson,
      seenPass, observedMs);
    removePairs.run(item.fileId);
    for (const pair of item.pairs) addPair.run(item.fileId, pair.anidbId, pair.episodeId);
  }
  return {
    deliverPendingChanges({ handle, limit = 100 } = {}) {
      if (typeof handle !== 'function' || !Number.isSafeInteger(limit) ||
          limit < 1 || limit > 100) throw new TypeError('Invalid change delivery');
      let count = 0;
      while (count < limit) {
        const change = nextUndelivered.get();
        if (!change) break;
        try {
          const result = handle({ before: JSON.parse(change.beforeJson),
            after: JSON.parse(change.afterJson),
            observedMs: change.observedMs });
          if (result && typeof result.then === 'function') {
            void Promise.resolve(result).catch(() => {});
            return held('change_delivery_failed');
          }
        } catch { return held('change_delivery_failed'); }
        if (markDelivered.run(change.id).changes !== 1) {
          return held('change_delivery_failed');
        }
        count++;
      }
      if (count === limit && nextUndelivered.get()) {
        return held('change_delivery_backlog');
      }
      return { state: 'delivered', count };
    },
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
          !Array.isArray(result.items) || result.items.length > activePageSize ||
          (result.items.length === 0 &&
            (expected.page - 1) * activePageSize < result.total)) {
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
        let pass = findPass.get(current.pass);
        if (!pass) {
          startPass.run(current.pass, result.total, observedMs);
          pass = findPass.get(current.pass);
        }
        const offset = (current.page - 1) * activePageSize;
        const ordered = result.items.every((item, index) =>
          item.fileId > (index === 0 ? pass.lastFileId :
            result.items[index - 1].fileId));
        const consistent = pass.status === 'running' &&
          (current.page === 1 || pass.startedMs <= observedMs) &&
          pass.total === result.total && pass.seenCount === offset &&
          result.items.length === Math.min(activePageSize,
            Math.max(0, result.total - offset)) && ordered &&
          (current.page === 1 || pass.seenCount > 0);
        const count = pass.seenCount + result.items.length;
        const digest = consistent ? createHash('sha256')
          .update(pass.digest).update('|')
          .update(result.items.map((item) => item.fileId).join(','))
          .digest('hex') : pass.digest;
        const last = current.page * activePageSize >= result.total;
        let status = consistent ? (last && count === result.total
          ? 'complete' : 'running') : 'invalid';
        const retired = [];
        let retirementHeld;
        if (status === 'complete') {
          const prior = findPass.get(current.pass - 1);
          if (prior?.status === 'complete' && prior.total === result.total &&
              prior.digest === digest) {
            const candidates = omitted.all(prior.pass, prior.startedMs);
            if (candidates.length > 100) {
              status = 'invalid';
              retirementHeld = 'omission_budget_exceeded';
            } else {
              for (const before of candidates) {
                const old = { fileId: before.fileId, updated: before.updated,
                  state: before.state, pairs: JSON.parse(before.pairsJson),
                  seenPass: before.seenPass, observedMs: before.observedMs };
                saveObservation({ fileId: old.fileId, updated: old.updated,
                  state: 'unverified', pairs: [] }, current.pass, observedMs);
                retired.push({ before: old, after: { ...old,
                  state: 'unverified', pairs: [], seenPass: current.pass,
                  observedMs } });
              }
            }
          }
        }
        updatePass.run(count, result.items.at(-1)?.fileId ?? pass.lastFileId,
          digest, status, current.pass);
        const nextPage = last ? 1 : current.page + 1;
        const nextPass = last ? current.pass + 1 : current.pass;
        advance.run(nextPage, nextPass, current.page, current.pass);
        if (last) prunePasses.run(current.pass - 1);
        db.exec('COMMIT'); begun = false;
        return { state: 'recorded', page: current.page, pass: current.pass,
          nextPage, ...(retired.length ? { retired } : {}),
          ...(retirementHeld ? { retirementHeld } : {}) };
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
      typeof ledger?.deliverPendingChanges !== 'function' ||
      typeof readPage !== 'function' || typeof now !== 'function' ||
      (onChangedFile !== undefined && typeof onChangedFile !== 'function')) {
    throw new TypeError('Invalid Shoko inventory worker');
  }
  return {
    async tick() {
      if (onChangedFile) {
        const pending = ledger.deliverPendingChanges({ handle: onChangedFile });
        if (pending.state === 'held' || pending.count > 0) return pending;
      }
      const expected = ledger.getCursor();
      // Timestamp the page before its HTTP read. A targeted event recheck
      // completed during that read must outrank this older page snapshot.
      const observedMs = now();
      let result;
      try { result = await readPage({ page: expected.page, pageSize: expected.pageSize }); }
      catch { return held('file_page_unavailable'); }
      if (result?.state !== 'page') return held('file_page_unavailable');
      const saved = ledger.recordPage({ expected, result, observedMs });
      if (saved.state === 'recorded' && onChangedFile) {
        const delivery = ledger.deliverPendingChanges({ handle: onChangedFile });
        if (delivery.state === 'held') return delivery;
      }
      if (saved.state === 'recorded' && saved.retired) {
        const { retired, ...summary } = saved;
        return summary;
      }
      return saved;
    },
  };
}
