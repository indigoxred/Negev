import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createShokoEventConsumer } from
  '../src/availability/shoko-event-consumer.mjs';
import { createShokoFullReconciliation } from
  '../src/availability/shoko-full-reconciliation.mjs';
import { createShokoInventoryWorker, openShokoInventoryLedger } from
  '../src/availability/shoko-inventory-worker.mjs';

test('an event during a full page invalidates that pass as gap proof', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-full-gap-event-'));
  const ledger = openShokoInventoryLedger(path.join(dir, 'inventory.sqlite'));
  const consumer = createShokoEventConsumer({ refreshFile: async () =>
    ({ state: 'recorded_file' }) });
  consumer.flagReconciliation();
  let nowMs = 100;
  let eventDuringRead = true;
  const worker = createShokoInventoryWorker({ ledger, now: () => nowMs++,
    readPage: async () => {
      if (eventDuringRead) {
        eventDuringRead = false;
        consumer.flagReconciliation();
      }
      return { state: 'page', page: 1, total: 0, items: [] };
    } });
  const coordinator = createShokoFullReconciliation({ ledger, consumer,
    readConnectionState: () => ({ state: 'connected' }),
    tickPage: () => worker.tick() });
  try {
    assert.equal((await coordinator.tick()).state, 'held');
    assert.equal(consumer.getState().fullReconciliationNeeded, true);
    assert.equal((await coordinator.tick()).state, 'held');
    assert.equal(consumer.getState().fullReconciliationNeeded, true);
    assert.equal((await coordinator.tick()).state, 'recorded');
    assert.equal(consumer.getState().fullReconciliationNeeded, false);
  } finally { await consumer.close(); ledger.close();
    await rm(dir, { recursive: true, force: true }); }
});

test('a restart cannot reuse a prior pass proof to clear the feed gap', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-full-gap-restart-'));
  const ledger = openShokoInventoryLedger(path.join(dir, 'inventory.sqlite'));
  const consumer = createShokoEventConsumer({ refreshFile: async () =>
    ({ state: 'recorded_file' }) });
  consumer.flagReconciliation();
  let nowMs = 100;
  const worker = createShokoInventoryWorker({ ledger, now: () => nowMs++,
    readPage: async () => ({ state: 'page', page: 1, total: 0, items: [] }) });
  const makeCoordinator = () => createShokoFullReconciliation({ ledger,
    consumer, readConnectionState: () => ({ state: 'connected' }),
    tickPage: () => worker.tick() });
  try {
    assert.equal((await makeCoordinator().tick()).state, 'held');
    const restarted = makeCoordinator();
    assert.equal((await restarted.tick()).state, 'held');
    assert.equal(consumer.getState().fullReconciliationNeeded, true);
    assert.equal((await restarted.tick()).state, 'recorded');
    assert.equal(consumer.getState().fullReconciliationNeeded, false);
  } finally { await consumer.close(); ledger.close();
    await rm(dir, { recursive: true, force: true }); }
});

test('an unavailable page discards an earlier pass proof', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-full-gap-outage-'));
  const ledger = openShokoInventoryLedger(path.join(dir, 'inventory.sqlite'));
  const consumer = createShokoEventConsumer({ refreshFile: async () =>
    ({ state: 'recorded_file' }) });
  consumer.flagReconciliation();
  let nowMs = 100;
  let fail = false;
  const worker = createShokoInventoryWorker({ ledger, now: () => nowMs++,
    readPage: async () => {
      if (fail) { fail = false; throw new Error('Shoko unavailable'); }
      return { state: 'page', page: 1, total: 0, items: [] };
    } });
  const coordinator = createShokoFullReconciliation({ ledger, consumer,
    readConnectionState: () => ({ state: 'connected' }),
    tickPage: () => worker.tick() });
  try {
    assert.equal((await coordinator.tick()).state, 'held');
    fail = true;
    assert.deepEqual(await coordinator.tick(),
      { state: 'held', reason: 'file_page_unavailable' });
    assert.equal((await coordinator.tick()).state, 'held');
    assert.equal(consumer.getState().fullReconciliationNeeded, true);
    assert.equal((await coordinator.tick()).state, 'recorded');
    assert.equal(consumer.getState().fullReconciliationNeeded, false);
  } finally { await consumer.close(); ledger.close();
    await rm(dir, { recursive: true, force: true }); }
});

test('a thrown page error also discards an earlier pass proof', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-full-gap-throw-'));
  const ledger = openShokoInventoryLedger(path.join(dir, 'inventory.sqlite'));
  const consumer = createShokoEventConsumer({ refreshFile: async () =>
    ({ state: 'recorded_file' }) });
  consumer.flagReconciliation();
  let nowMs = 100;
  let fail = false;
  const worker = createShokoInventoryWorker({ ledger, now: () => nowMs++,
    readPage: async () => ({ state: 'page', page: 1, total: 0, items: [] }) });
  const coordinator = createShokoFullReconciliation({ ledger, consumer,
    readConnectionState: () => ({ state: 'connected' }),
    tickPage: () => {
      if (fail) { fail = false; throw new Error('ledger unavailable'); }
      return worker.tick();
    } });
  try {
    assert.equal((await coordinator.tick()).state, 'held');
    fail = true;
    await assert.rejects(coordinator.tick(), /ledger unavailable/);
    assert.equal((await coordinator.tick()).state, 'held');
    assert.equal(consumer.getState().fullReconciliationNeeded, true);
    assert.equal((await coordinator.tick()).state, 'recorded');
    assert.equal(consumer.getState().fullReconciliationNeeded, false);
  } finally { await consumer.close(); ledger.close();
    await rm(dir, { recursive: true, force: true }); }
});
