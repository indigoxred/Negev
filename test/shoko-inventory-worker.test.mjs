import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createShokoInventoryWorker, openShokoInventoryLedger } from
  '../src/availability/shoko-inventory-worker.mjs';
import { openDirectAvailabilityQueue } from
  '../src/availability/direct-availability-queue.mjs';

const provisional = { fileId: 10, updated: '2026-10-31T00:00:00Z',
  state: 'provisional', pairs: [] };
const linked = { ...provisional, updated: '2026-10-31T01:00:00Z', state: 'linked',
  pairs: [{ anidbId: 42, episodeId: 1001 }] };

test('an excessive omission is identified separately from a transient bad page', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-shoko-omission-cap-'));
  const ledger = openShokoInventoryLedger(path.join(dir, 'inventory.sqlite'));
  try {
    for (let fileId = 1; fileId <= 101; fileId++) {
      ledger.recordFileObservation({ item: { ...linked, fileId }, observedMs: 1 });
    }
    const empty = { state: 'page', page: 1, total: 0, items: [] };
    assert.equal(ledger.recordPage({ expected: ledger.getCursor(),
      result: empty, observedMs: 100 }).state, 'recorded');
    assert.deepEqual(ledger.recordPage({ expected: ledger.getCursor(),
      result: empty, observedMs: 200 }),
    { state: 'held', reason: 'omission_budget_exceeded' });
    assert.deepEqual(ledger.getCursor(), { page: 1, pass: 3, pageSize: 100 });
  } finally { ledger.close(); await rm(dir, { recursive: true, force: true }); }
});

test('inventory change receipts omit optional source path hints', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-shoko-hint-receipt-'));
  const dbPath = path.join(dir, 'inventory.sqlite');
  const ledger = openShokoInventoryLedger(dbPath);
  try {
    const item = { ...linked, hint: { size: 5,
      sourcePaths: ['/pure/private/episode.mkv'] } };
    assert.equal(ledger.recordFileObservation({ item, observedMs: 100 }).state,
      'recorded_file');
    const changes = [];
    assert.deepEqual(ledger.deliverPendingChanges({
      handle: (change) => changes.push(change) }),
    { state: 'delivered', count: 1 });
    assert.deepEqual(changes[0].after, { ...linked,
      seenPass: 0, observedMs: 100 });
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare(`SELECT after_json AS afterJson
        FROM shoko_file_change_events ORDER BY id DESC LIMIT 1`).get();
      assert.equal(row.afterJson.includes('/pure/private/'), false);
    } finally { db.close(); }
  } finally { ledger.close(); await rm(dir, { recursive: true, force: true }); }
});

test('source hints survive restart but are withdrawn when Shoko identity changes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-shoko-hint-state-'));
  const dbPath = path.join(dir, 'inventory.sqlite');
  let ledger = openShokoInventoryLedger(dbPath);
  try {
    const hint = { size: 5, sourcePaths: ['/pure/Anime/episode.mkv'] };
    const withHint = { ...linked, hint };
    assert.equal(ledger.recordFileObservation({ item: withHint,
      observedMs: 100 }).state, 'recorded_file');
    assert.deepEqual(ledger.getFileHint(linked.fileId), { ...hint,
      updated: linked.updated, observedMs: 100 });
    ledger.close();
    ledger = openShokoInventoryLedger(dbPath);
    assert.deepEqual(ledger.getFileHint(linked.fileId), { ...hint,
      updated: linked.updated, observedMs: 100 });
    ledger.recordFileObservation({ item: linked, observedMs: 200 });
    assert.deepEqual(ledger.getFileHint(linked.fileId), { ...hint,
      updated: linked.updated, observedMs: 100 });
    ledger.recordFileObservation({ item: { ...linked,
      updated: '2026-10-31T02:00:00Z' }, observedMs: 300 });
    assert.equal(ledger.getFileHint(linked.fileId), null);
    ledger.recordFileObservation({ item: { ...linked,
      updated: '2026-10-31T02:00:00Z', hint }, observedMs: 400 });
    assert.deepEqual(ledger.getFileHint(linked.fileId), { ...hint,
      updated: '2026-10-31T02:00:00Z', observedMs: 400 });
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare(`UPDATE shoko_inventory_file_hints SET paths_json=?
        WHERE file_id=?`).run('["/pure/../escape.mkv"]', linked.fileId);
    } finally { db.close(); }
    assert.equal(ledger.getFileHint(linked.fileId), null);
  } finally { ledger?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('bad or inaccessible source hints cannot survive a newer page', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-shoko-hint-invalid-'));
  const ledger = openShokoInventoryLedger(path.join(dir, 'inventory.sqlite'),
    { pageSize: 1 });
  try {
    const hint = { size: 5, sourcePaths: ['/pure/Anime/episode.mkv'] };
    const page = (item) => ({ state: 'page', page: 1,
      total: 1, items: [item] });
    let expected = ledger.getCursor();
    assert.equal(ledger.recordPage({ expected,
      result: page({ ...linked, hint }), observedMs: 100 }).state, 'recorded');
    assert.equal(ledger.getFileHint(linked.fileId).size, 5);
    expected = ledger.getCursor();
    assert.equal(ledger.recordPage({ expected,
      result: page({ ...linked, hint: null }), observedMs: 200 }).state,
    'recorded');
    assert.equal(ledger.getFileHint(linked.fileId), null);
    expected = ledger.getCursor();
    assert.equal(ledger.recordPage({ expected,
      result: page({ ...linked, hint: { size: 5,
        sourcePaths: ['/pure/../escape.mkv'] } }), observedMs: 300 }).state,
    'recorded');
    assert.equal(ledger.getFileHint(linked.fileId), null);
  } finally { ledger.close(); await rm(dir, { recursive: true, force: true }); }
});

test('linked source hints page by file ID without treating absent hints as deletions', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-shoko-hint-page-'));
  const dbPath = path.join(dir, 'inventory.sqlite');
  let ledger = openShokoInventoryLedger(dbPath);
  try {
    const hint = { size: 5, sourcePaths: ['/pure/Anime/episode.mkv'] };
    for (const fileId of [10, 12, 14]) {
      ledger.recordFileObservation({ item: { ...linked, fileId, hint },
        observedMs: 100 + fileId });
    }
    assert.deepEqual(ledger.listFileHintIds({ afterFileId: 0, limit: 2 }),
      [10, 12]);
    ledger.close();
    ledger = openShokoInventoryLedger(dbPath);
    assert.deepEqual(ledger.listFileHintIds({ afterFileId: 12, limit: 2 }),
      [14]);
    ledger.recordFileObservation({ item: { ...linked, fileId: 12,
      hint: null }, observedMs: 200 });
    assert.deepEqual(ledger.listFileHintIds({ afterFileId: 0, limit: 10 }),
      [10, 14]);
    assert.deepEqual(ledger.listFileHintIds({ afterFileId: 14, limit: 10 }), []);
    assert.throws(() => ledger.listFileHintIds({ afterFileId: 0,
      limit: 1000 }), TypeError);
  } finally { ledger?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a failed change callback is redelivered after restart before another Shoko page', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-shoko-change-replay-'));
  const dbPath = path.join(dir, 'inventory.sqlite');
  let ledger;
  try {
    ledger = openShokoInventoryLedger(dbPath, { pageSize: 1 });
    const first = createShokoInventoryWorker({ ledger, now: () => 100,
      readPage: async () => ({ state: 'page', page: 1,
        total: 1, items: [linked] }),
      onChangedFile: () => { throw Error('queue temporarily unavailable'); } });
    assert.deepEqual(await first.tick(),
      { state: 'held', reason: 'change_delivery_failed' });
    assert.equal(ledger.getCursor().pass, 2);
    ledger.close(); ledger = null;
    ledger = openShokoInventoryLedger(dbPath, { pageSize: 1 });
    const delivered = [];
    const resumed = createShokoInventoryWorker({ ledger, now: () => 200,
      readPage: async () => { throw Error('page should not be read first'); },
      onChangedFile: (change) => delivered.push(change) });
    assert.deepEqual(await resumed.tick(), { state: 'delivered', count: 1 });
    assert.deepEqual(delivered, [{ before: null, after: {
      ...linked, seenPass: 1, observedMs: 100 }, observedMs: 100 }]);
    assert.deepEqual(await resumed.tick(),
      { state: 'held', reason: 'file_page_unavailable' });
    assert.equal(delivered.length, 1);
  } finally { ledger?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('old change rows remain historical when the delivery receipt is introduced', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-shoko-change-upgrade-'));
  const dbPath = path.join(dir, 'inventory.sqlite');
  let ledger;
  try {
    const queue = openDirectAvailabilityQueue(dbPath);
    queue.close();
    const db = new DatabaseSync(dbPath);
    db.prepare(`INSERT INTO shoko_file_change_events
      (file_id,observed_ms) VALUES (10,50)`).run();
    db.close();
    ledger = openShokoInventoryLedger(dbPath);
    const delivered = [];
    const handle = (change) => delivered.push(change);
    assert.deepEqual(ledger.deliverPendingChanges({ handle }),
      { state: 'delivered', count: 0 });
    ledger.recordFileObservation({ item: linked, observedMs: 100 });
    assert.deepEqual(ledger.deliverPendingChanges({ handle }),
      { state: 'delivered', count: 1 });
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].after.fileId, 10);
  } finally { ledger?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('an async change handler cannot acknowledge its receipt before completion', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-shoko-change-async-'));
  const ledger = openShokoInventoryLedger(path.join(dir, 'inventory.sqlite'));
  try {
    ledger.recordFileObservation({ item: linked, observedMs: 100 });
    assert.deepEqual(ledger.deliverPendingChanges({ handle: async () => {} }),
      { state: 'held', reason: 'change_delivery_failed' });
    assert.deepEqual(ledger.deliverPendingChanges({ handle: () => {} }),
      { state: 'delivered', count: 1 });
  } finally { ledger.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a rejected async handler is contained while its change remains pending', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-shoko-change-reject-'));
  const ledger = openShokoInventoryLedger(path.join(dir, 'inventory.sqlite'));
  try {
    ledger.recordFileObservation({ item: linked, observedMs: 100 });
    assert.deepEqual(ledger.deliverPendingChanges({
      handle: () => Promise.reject(Error('late callback failure')) }),
    { state: 'held', reason: 'change_delivery_failed' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(ledger.deliverPendingChanges({ handle: () => {} }),
      { state: 'delivered', count: 1 });
  } finally { ledger.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a held change handler keeps its receipt for a later retry', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-shoko-change-held-'));
  const ledger = openShokoInventoryLedger(path.join(dir, 'inventory.sqlite'));
  try {
    ledger.recordFileObservation({ item: linked, observedMs: 100 });
    assert.deepEqual(ledger.deliverPendingChanges({
      handle: () => ({ state: 'held', reason: 'queue_unavailable' }) }),
    { state: 'held', reason: 'change_delivery_failed' });
    assert.deepEqual(ledger.deliverPendingChanges({ handle: () => {} }),
      { state: 'delivered', count: 1 });
  } finally { ledger.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a bounded delivery batch reports backlog instead of acknowledging a later import', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-shoko-change-backlog-'));
  const ledger = openShokoInventoryLedger(path.join(dir, 'inventory.sqlite'));
  try {
    ledger.recordFileObservation({ item: linked, observedMs: 100 });
    ledger.recordFileObservation({ item: { ...linked,
      updated: '2026-10-31T02:00:00Z' }, observedMs: 101 });
    const delivered = [];
    const handle = (change) => delivered.push(change);
    assert.deepEqual(ledger.deliverPendingChanges({ handle, limit: 1 }),
      { state: 'held', reason: 'change_delivery_backlog' });
    assert.equal(delivered.length, 1);
    assert.deepEqual(ledger.deliverPendingChanges({ handle, limit: 1 }),
      { state: 'delivered', count: 1 });
    assert.equal(delivered.length, 2);
  } finally { ledger.close(); await rm(dir, { recursive: true, force: true }); }
});

test('durable one-page ticks revisit provisional files without claiming deletion', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-shoko-inventory-'));
  const dbPath = path.join(dir, 'inventory.sqlite');
  let ledger;
  try {
    ledger = openShokoInventoryLedger(dbPath, { pageSize: 1 });
    const first = createShokoInventoryWorker({ ledger, readPage: async ({ page }) =>
      ({ state: 'page', page, total: 2, items: page === 1 ? [provisional] : [{
        ...linked, fileId: 11 }] }), now: () => 100 });
    assert.deepEqual(await first.tick(), { state: 'recorded', page: 1, pass: 1, nextPage: 2 });
    assert.deepEqual(ledger.getFile(10), { ...provisional, seenPass: 1, observedMs: 100 });
    ledger.close();
    ledger = null;
    ledger = openShokoInventoryLedger(dbPath, { pageSize: 1 });
    const second = createShokoInventoryWorker({ ledger, readPage: async ({ page }) =>
      ({ state: 'page', page, total: 2, items: page === 2 ? [{ ...linked, fileId: 11 }] : [linked] }),
    now: () => 200 });
    assert.deepEqual(await second.tick(), { state: 'recorded', page: 2, pass: 1, nextPage: 1 });
    assert.deepEqual(await second.tick(), { state: 'recorded', page: 1, pass: 2, nextPage: 2 });
    assert.deepEqual(ledger.getFile(10), { ...linked, seenPass: 2, observedMs: 200 });
    assert.equal(ledger.getFile(11).seenPass, 1);
    assert.deepEqual(ledger.getObservedFileIds({ anidbId: 42, episodeId: 1001 }), [10, 11]);
  } finally { ledger?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('two matching complete omissions retire only the missing file and announce old pairs', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-shoko-omission-'));
  const dbPath = path.join(dir, 'inventory.sqlite');
  let ledger = openShokoInventoryLedger(dbPath, { pageSize: 2 });
  try {
    let items = [linked, { ...linked, fileId: 11,
      pairs: [{ anidbId: 43, episodeId: 2001 }] }];
    let instant = 100;
    const changes = [];
    const worker = createShokoInventoryWorker({ ledger, now: () => instant,
      readPage: async () => ({ state: 'page', page: 1,
        total: items.length, items }), onChangedFile: (change) => changes.push(change) });
    assert.equal((await worker.tick()).state, 'recorded');
    ledger.close();
    ledger = openShokoInventoryLedger(dbPath, { pageSize: 2 });
    items = [linked]; instant = 200;
    const resumed = createShokoInventoryWorker({ ledger, now: () => instant,
      readPage: async () => ({ state: 'page', page: 1,
        total: items.length, items }), onChangedFile: (change) => changes.push(change) });
    assert.equal((await resumed.tick()).state, 'recorded');
    assert.deepEqual(ledger.getObservedFileIds({ anidbId: 43,
      episodeId: 2001 }), [11]);
    instant = 300;
    assert.equal((await resumed.tick()).state, 'recorded');
    assert.deepEqual(ledger.getObservedFileIds({ anidbId: 43,
      episodeId: 2001 }), []);
    assert.deepEqual(ledger.getObservedFileIds({ anidbId: 42,
      episodeId: 1001 }), [10]);
    assert.deepEqual(changes.at(-1).before.pairs,
      [{ anidbId: 43, episodeId: 2001 }]);
    assert.deepEqual(changes.at(-1).after.pairs, []);
  } finally { ledger?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('confirmed omission atomically invalidates a proven direct badge without a callback', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-shoko-omission-'));
  const dbPath = path.join(dir, 'inventory.sqlite');
  const queue = openDirectAvailabilityQueue(dbPath);
  const ledger = openShokoInventoryLedger(dbPath, { pageSize: 2 });
  try {
    const page = (items, observedMs) => ledger.recordPage({
      expected: ledger.getCursor(), observedMs,
      result: { state: 'page', page: 1, total: items.length, items } });
    page([linked], 100);
    const target = { anidbId: 42, episodeId: 1001 };
    queue.enqueue({ ...target, observedMs: 110 });
    const claim = queue.claimNext({ nowMs: 110 });
    queue.recordResult({ claim, state: 'available', checkedMs: 111,
      proof: { fileId: 10, libraryId: 102, ratingKey: 500,
        partId: 600 } });
    page([], 200);
    assert.equal(queue.getStatus({ ...target, nowMs: 200 }).state, 'available');
    page([], 300);
    assert.deepEqual(queue.getStatus({ ...target, nowMs: 300 }),
      { state: 'unknown' });
    assert.equal(queue.claimNext({ nowMs: 300 }).state, 'claimed');
  } finally {
    ledger.close(); queue.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a Shoko file change rejects an in-flight proof even when its page timestamp is earlier', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-shoko-omission-'));
  const dbPath = path.join(dir, 'inventory.sqlite');
  const queue = openDirectAvailabilityQueue(dbPath);
  const ledger = openShokoInventoryLedger(dbPath, { pageSize: 2 });
  try {
    ledger.recordFileObservation({ item: linked, observedMs: 100 });
    const target = { anidbId: 42, episodeId: 1001 };
    queue.enqueue({ ...target, observedMs: 150 });
    const claim = queue.claimNext({ nowMs: 200 });
    ledger.recordFileObservation({ item: { ...linked,
      state: 'unverified', pairs: [] }, observedMs: 190 });
    assert.deepEqual(queue.recordResult({ claim, state: 'available',
      checkedMs: 210, proof: { fileId: 10, libraryId: 102,
        ratingKey: 500, partId: 600 } }),
    { state: 'held', reason: 'shoko_changed' });
    assert.deepEqual(queue.getStatus({ ...target, nowMs: 210 }),
      { state: 'unknown' });
  } finally {
    ledger.close(); queue.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('an explicit Shoko unlink clears its proven badge without waiting for a sweep', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-shoko-unlink-'));
  const dbPath = path.join(dir, 'inventory.sqlite');
  const queue = openDirectAvailabilityQueue(dbPath);
  const ledger = openShokoInventoryLedger(dbPath, { pageSize: 2 });
  try {
    ledger.recordFileObservation({ item: linked, observedMs: 100 });
    const target = { anidbId: 42, episodeId: 1001 };
    queue.enqueue({ ...target, observedMs: 110 });
    const claim = queue.claimNext({ nowMs: 110 });
    queue.recordResult({ claim, state: 'available', checkedMs: 111,
      proof: { fileId: 10, libraryId: 102, ratingKey: 500,
        partId: 600 } });
    ledger.recordFileObservation({ item: { ...linked,
      state: 'unverified', pairs: [] }, observedMs: 120 });
    assert.deepEqual(queue.getStatus({ ...target, nowMs: 120 }),
      { state: 'unknown' });
  } finally {
    ledger.close(); queue.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a lost Shoko source path withdraws a proven badge without unlinking its episode', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-shoko-hint-withdraw-'));
  const dbPath = path.join(dir, 'inventory.sqlite');
  const queue = openDirectAvailabilityQueue(dbPath);
  const ledger = openShokoInventoryLedger(dbPath);
  try {
    const target = { anidbId: 42, episodeId: 1001 };
    const hint = { size: 5, sourcePaths: ['/pure/Anime/episode.mkv'] };
    ledger.recordFileObservation({ item: { ...linked, hint }, observedMs: 100 });
    queue.enqueue({ ...target, observedMs: 110 });
    const claim = queue.claimNext({ nowMs: 110 });
    queue.recordResult({ claim, state: 'available', checkedMs: 111,
      proof: { fileId: 10, libraryId: 102, ratingKey: 500, partId: 600 } });
    assert.equal(queue.getStatus({ ...target, nowMs: 115 }).state, 'available');
    ledger.recordFileObservation({ item: { ...linked, hint: null },
      observedMs: 120 });
    assert.equal(ledger.getFileHint(10), null);
    assert.equal(queue.getStatus({ ...target, nowMs: 120 }).state, 'unknown');
    assert.equal(queue.claimNext({ nowMs: 120 }).state, 'claimed');
  } finally {
    ledger.close(); queue.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a newer targeted file event prevents two old inventory passes from retiring it', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-shoko-omission-'));
  const ledger = openShokoInventoryLedger(path.join(dir, 'inventory.sqlite'),
    { pageSize: 2 });
  try {
    const page = (items, observedMs) => ledger.recordPage({
      expected: ledger.getCursor(), observedMs,
      result: { state: 'page', page: 1, total: items.length, items } });
    page([linked], 100);
    page([], 200);
    ledger.recordFileObservation({ item: linked, observedMs: 250 });
    page([], 300);
    assert.deepEqual(ledger.getObservedFileIds({ anidbId: 42,
      episodeId: 1001 }), [10]);
  } finally { ledger.close(); await rm(dir, { recursive: true, force: true }); }
});

test('changed totals within a pass cannot become two-pass deletion evidence', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-shoko-omission-'));
  const ledger = openShokoInventoryLedger(path.join(dir, 'inventory.sqlite'),
    { pageSize: 1 });
  try {
    ledger.recordFileObservation({ item: linked, observedMs: 50 });
    const page = (pageNum, total, items, observedMs) =>
      ledger.recordPage({ expected: ledger.getCursor(), observedMs,
        result: { state: 'page', page: pageNum, total, items } });
    page(1, 2, [{ ...provisional, fileId: 11 }], 100);
    page(2, 3, [{ ...provisional, fileId: 12 }], 101);
    page(3, 3, [{ ...provisional, fileId: 13 }], 102);
    page(1, 2, [{ ...provisional, fileId: 11 }], 200);
    page(2, 2, [{ ...provisional, fileId: 12 }], 201);
    assert.deepEqual(ledger.getObservedFileIds({ anidbId: 42,
      episodeId: 1001 }), [10]);
  } finally { ledger.close(); await rm(dir, { recursive: true, force: true }); }
});

test('two complete empty passes retire the final old file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-shoko-omission-'));
  const ledger = openShokoInventoryLedger(path.join(dir, 'inventory.sqlite'),
    { pageSize: 2 });
  try {
    const page = (items, observedMs) => ledger.recordPage({
      expected: ledger.getCursor(), observedMs,
      result: { state: 'page', page: 1, total: items.length, items } });
    page([linked], 100);
    page([], 200);
    assert.deepEqual(ledger.getObservedFileIds({ anidbId: 42,
      episodeId: 1001 }), [10]);
    page([], 300);
    assert.deepEqual(ledger.getObservedFileIds({ anidbId: 42,
      episodeId: 1001 }), []);
  } finally { ledger.close(); await rm(dir, { recursive: true, force: true }); }
});

test('duplicate IDs across offset pages never become deletion evidence', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-shoko-omission-'));
  const ledger = openShokoInventoryLedger(path.join(dir, 'inventory.sqlite'),
    { pageSize: 1 });
  try {
    ledger.recordFileObservation({ item: linked, observedMs: 50 });
    const page = (items, total, observedMs) => ledger.recordPage({
      expected: ledger.getCursor(), observedMs,
      result: { state: 'page', page: ledger.getCursor().page, total, items } });
    page([{ ...provisional, fileId: 11 }], 2, 100);
    page([{ ...provisional, fileId: 11 }], 2, 101);
    page([{ ...provisional, fileId: 11 }], 1, 200);
    assert.deepEqual(ledger.getObservedFileIds({ anidbId: 42,
      episodeId: 1001 }), [10]);
  } finally { ledger.close(); await rm(dir, { recursive: true, force: true }); }
});

test('outage and stale concurrent page do not advance or erase observations', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-shoko-inventory-'));
  const dbPath = path.join(dir, 'inventory.sqlite');
  let ledger;
  try {
    ledger = openShokoInventoryLedger(dbPath, { pageSize: 1 });
    const down = createShokoInventoryWorker({ ledger, readPage: async () =>
      ({ state: 'unavailable' }) });
    assert.deepEqual(await down.tick(), { state: 'held', reason: 'file_page_unavailable' });
    assert.deepEqual(ledger.getCursor(), { page: 1, pass: 1, pageSize: 1 });
    let release;
    const slow = createShokoInventoryWorker({ ledger, readPage: async () =>
      new Promise((resolve) => { release = resolve; }) });
    const pending = slow.tick();
    await Promise.resolve();
    const fast = createShokoInventoryWorker({ ledger, readPage: async () =>
      ({ state: 'page', page: 1, total: 1, items: [provisional] }) });
    assert.equal((await fast.tick()).state, 'recorded');
    release({ state: 'page', page: 1, total: 1, items: [linked] });
    assert.deepEqual(await pending, { state: 'held', reason: 'stale_cursor' });
    assert.equal(ledger.getFile(10).state, 'provisional');
  } finally { ledger?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('an inconsistent second page cannot replace a known file observation', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-shoko-invalid-page-'));
  const ledger = openShokoInventoryLedger(path.join(dir, 'inventory.sqlite'),
    { pageSize: 1 });
  try {
    assert.equal(ledger.recordFileObservation({ item: linked,
      observedMs: 50 }).state, 'recorded_file');
    const page = (items) => ledger.recordPage({ expected: ledger.getCursor(),
      observedMs: 100, result: { state: 'page',
        page: ledger.getCursor().page, total: 2, items } });
    assert.equal(page([{ ...provisional, fileId: 11 }]).state, 'recorded');
    assert.deepEqual(page([provisional]),
      { state: 'held', reason: 'invalid_file_pass' });
    assert.deepEqual(ledger.getCursor(), { page: 1, pass: 2, pageSize: 1 });
    assert.equal(ledger.getFile(10).state, 'linked');
    assert.deepEqual(ledger.getObservedFileIds({ anidbId: 42,
      episodeId: 1001 }), [10]);
  } finally { ledger.close(); await rm(dir, { recursive: true, force: true }); }
});

test('an unverified file is held while the next linked file advances', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-shoko-inventory-'));
  const dbPath = path.join(dir, 'inventory.sqlite');
  let ledger;
  try {
    ledger = openShokoInventoryLedger(dbPath, { pageSize: 2 });
    const worker = createShokoInventoryWorker({ ledger, readPage: async () => ({
      state: 'page', page: 1, total: 2, items: [
        { ...provisional, state: 'unverified' }, { ...linked, fileId: 11 },
      ],
    }) });
    assert.equal((await worker.tick()).state, 'recorded');
    assert.equal(ledger.getFile(10).state, 'unverified');
    assert.deepEqual(ledger.getFile(11).pairs, linked.pairs);
    assert.deepEqual(ledger.getObservedFileIds({ anidbId: 42, episodeId: 1001 }), [11]);
  } finally { ledger?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('later unverified evidence withdraws only its own provisional identity index', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-shoko-inventory-'));
  const dbPath = path.join(dir, 'inventory.sqlite');
  let ledger;
  try {
    ledger = openShokoInventoryLedger(dbPath, { pageSize: 1 });
    let item = linked;
    const worker = createShokoInventoryWorker({ ledger, readPage: async () => ({
      state: 'page', page: 1, total: 1, items: [item],
    }) });
    assert.equal((await worker.tick()).state, 'recorded');
    assert.deepEqual(ledger.getObservedFileIds({ anidbId: 42, episodeId: 1001 }), [10]);
    item = { ...linked, state: 'unverified', pairs: [] };
    assert.equal((await worker.tick()).state, 'recorded');
    assert.deepEqual(ledger.getObservedFileIds({ anidbId: 42, episodeId: 1001 }), []);
    assert.equal(ledger.getFile(10).state, 'unverified');
  } finally { ledger?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('one event-triggered file observation updates identity without advancing a full scan', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-shoko-inventory-'));
  const dbPath = path.join(dir, 'inventory.sqlite');
  let ledger;
  try {
    ledger = openShokoInventoryLedger(dbPath, { pageSize: 2 });
    assert.deepEqual(ledger.recordFileObservation({ item: linked, observedMs: 200 }),
      { state: 'recorded_file', fileId: 10 });
    assert.deepEqual(ledger.getCursor(), { page: 1, pass: 1, pageSize: 2 });
    assert.deepEqual(ledger.getObservedFileIds({ anidbId: 42, episodeId: 1001 }), [10]);
    assert.equal(ledger.getFile(10).seenPass, 0);
    assert.equal(ledger.recordPage({ expected: ledger.getCursor(), observedMs: 200,
      result: { state: 'page', page: 1, total: 1, items: [provisional] } }).state, 'recorded');
    assert.deepEqual(ledger.getObservedFileIds({ anidbId: 42, episodeId: 1001 }), [10]);
  } finally { ledger?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a page fetched before a file event cannot overwrite that newer event', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-shoko-inventory-'));
  const ledger = openShokoInventoryLedger(path.join(dir, 'inventory.sqlite'),
    { pageSize: 1 });
  try {
    let release;
    let instant = 100;
    const worker = createShokoInventoryWorker({ ledger, now: () => instant,
      readPage: () => new Promise((resolve) => { release = resolve; }) });
    const pending = worker.tick();
    instant = 200;
    ledger.recordFileObservation({ item: linked, observedMs: instant });
    release({ state: 'page', page: 1, total: 1, items: [provisional] });
    assert.equal((await pending).state, 'recorded');
    assert.deepEqual(ledger.getObservedFileIds({ anidbId: 42, episodeId: 1001 }), [10]);
    assert.equal(ledger.getFile(10).state, 'linked');
  } finally { ledger.close(); await rm(dir, { recursive: true, force: true }); }
});

test('page reconciliation announces changed file identities once, not every pass', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-shoko-page-change-'));
  const ledger = openShokoInventoryLedger(path.join(dir, 'inventory.sqlite'),
    { pageSize: 1 });
  try {
    let item = linked;
    let instant = 100;
    const changes = [];
    const worker = createShokoInventoryWorker({ ledger, now: () => instant,
      readPage: async () => ({ state: 'page', page: 1,
        total: 1, items: [item] }),
      onChangedFile: (change) => changes.push(change) });
    assert.equal((await worker.tick()).state, 'recorded');
    instant++;
    assert.equal((await worker.tick()).state, 'recorded');
    item = { ...linked, updated: '2026-10-31T02:00:00Z',
      state: 'unverified', pairs: [] };
    instant++;
    assert.equal((await worker.tick()).state, 'recorded');
    assert.equal(changes.length, 2);
    assert.equal(changes[0].before, null);
    assert.deepEqual(changes[0].after.pairs, linked.pairs);
    assert.deepEqual(changes[1].before.pairs, linked.pairs);
    assert.deepEqual(changes[1].after.pairs, []);
  } finally { ledger.close(); await rm(dir, { recursive: true, force: true }); }
});

test('new inventory uses 100-file pages while an existing 25-file cursor keeps its position', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-shoko-page-size-'));
  const dbPath = path.join(dir, 'inventory.sqlite');
  let ledger;
  try {
    ledger = openShokoInventoryLedger(dbPath, { pageSize: 25 });
    ledger.close();
    ledger = openShokoInventoryLedger(dbPath);
    assert.deepEqual(ledger.getCursor(), { page: 1, pass: 1, pageSize: 25 });
    const items = Array.from({ length: 25 }, (_, index) => ({
      ...provisional, fileId: 100 + index,
    }));
    assert.deepEqual(ledger.recordPage({ expected: ledger.getCursor(),
      observedMs: 100, result: { state: 'page', page: 1, total: 26, items } }),
    { state: 'recorded', page: 1, pass: 1, nextPage: 2 });
    ledger.close();
    ledger = openShokoInventoryLedger(path.join(dir, 'new.sqlite'));
    assert.equal(ledger.getCursor().pageSize, 100);
  } finally { ledger?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('legacy path-sorted cursor restarts its pass before switching to file-ID order', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-shoko-sort-upgrade-'));
  const dbPath = path.join(dir, 'inventory.sqlite');
  const old = new DatabaseSync(dbPath);
  old.exec(`CREATE TABLE shoko_inventory_cursor (
    id INTEGER PRIMARY KEY CHECK(id=1),
    page INTEGER NOT NULL CHECK(page>0),
    pass INTEGER NOT NULL CHECK(pass>0),
    page_size INTEGER NOT NULL CHECK(page_size BETWEEN 1 AND 50)
  ) STRICT;
  INSERT INTO shoko_inventory_cursor VALUES (1,2,3,25);
  CREATE TABLE shoko_inventory_files (
    file_id INTEGER PRIMARY KEY,
    updated TEXT NOT NULL,
    state TEXT NOT NULL,
    pairs_json TEXT NOT NULL,
    seen_pass INTEGER NOT NULL,
    observed_ms INTEGER NOT NULL
  ) STRICT;
  INSERT INTO shoko_inventory_files VALUES
    (10,'2026-10-31T01:00:00Z','linked','[{"anidbId":42,"episodeId":1001}]',3,100);
  CREATE TABLE shoko_inventory_pairs (
    file_id INTEGER NOT NULL,
    anidb_id INTEGER NOT NULL,
    episode_id INTEGER NOT NULL,
    PRIMARY KEY(file_id,anidb_id,episode_id)
  ) STRICT;
  INSERT INTO shoko_inventory_pairs VALUES (10,42,1001)`);
  old.close();
  let ledger;
  try {
    ledger = openShokoInventoryLedger(dbPath);
    assert.deepEqual(ledger.getCursor(), { page: 1, pass: 4, pageSize: 25 });
    assert.deepEqual(ledger.getObservedFileIds({ anidbId: 42, episodeId: 1001 }), [10]);
    ledger.close();
    ledger = openShokoInventoryLedger(dbPath);
    assert.deepEqual(ledger.getCursor(), { page: 1, pass: 4, pageSize: 25 });
  } finally { ledger?.close(); await rm(dir, { recursive: true, force: true }); }
});
