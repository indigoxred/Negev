import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createShokoInventoryWorker, openShokoInventoryLedger } from
  '../src/availability/shoko-inventory-worker.mjs';

const provisional = { fileId: 10, updated: '2026-10-31T00:00:00Z',
  state: 'provisional', pairs: [] };
const linked = { ...provisional, updated: '2026-10-31T01:00:00Z', state: 'linked',
  pairs: [{ anidbId: 42, episodeId: 1001 }] };

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
