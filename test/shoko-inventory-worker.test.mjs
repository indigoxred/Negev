import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
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
    assert.deepEqual(ledger.recordFileObservation({ item: linked, observedMs: 300 }),
      { state: 'recorded_file', fileId: 10 });
    assert.deepEqual(ledger.getCursor(), { page: 1, pass: 1, pageSize: 2 });
    assert.deepEqual(ledger.getObservedFileIds({ anidbId: 42, episodeId: 1001 }), [10]);
    assert.equal(ledger.getFile(10).seenPass, 0);
    assert.equal(ledger.recordPage({ expected: ledger.getCursor(), observedMs: 200,
      result: { state: 'page', page: 1, total: 1, items: [provisional] } }).state, 'recorded');
    assert.deepEqual(ledger.getObservedFileIds({ anidbId: 42, episodeId: 1001 }), [10]);
  } finally { ledger?.close(); await rm(dir, { recursive: true, force: true }); }
});
