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
import { createShokoInventoryScheduler } from
  '../src/availability/shoko-inventory-scheduler.mjs';
import { observeImportQuietWindow, scopedImportFeedState } from
  '../src/acquisition/import-quiet-window.mjs';

test('startup sweep remains daily while an uncertain request gets bounded Import readiness', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-startup-ready-'));
  const ledger = openShokoInventoryLedger(path.join(dir, 'inventory.sqlite'));
  const consumer = createShokoEventConsumer({ refreshFile: async () =>
    ({ state: 'recorded_file' }) });
  consumer.flagReconciliation('feed_started');
  let nowMs = 100;
  const worker = createShokoInventoryWorker({ ledger, now: () => nowMs++,
    readPage: async () => ({ state: 'page', page: 1, total: 0, items: [] }) });
  const coordinator = createShokoFullReconciliation({ ledger, consumer,
    readConnectionState: () => ({ state: 'connected' }),
    tickPage: () => worker.tick() });
  const timers = new Map();
  let nextTimer = 0;
  const scheduler = createShokoInventoryScheduler({ tick: () => coordinator.tick(),
    setTimer: (callback, delay) => { const id = ++nextTimer;
      timers.set(id, { callback, delay }); return id; },
    clearTimer: (id) => timers.delete(id) });
  try {
    scheduler.start();
    const first = timers.entries().next().value;
    timers.delete(first[0]);
    await first[1].callback();
    assert.equal(scheduler.getState().state, 'catchup_wait');
    assert.equal(timers.values().next().value.delay, 86_400_000);
    assert.equal(consumer.getState().fullReconciliationNeeded, true);
    let clock = 1_000_000;
    const readFeed = (allowedPendingKeys) => scopedImportFeedState({
      connection: { state: 'connected' },
      snapshot: consumer.getPendingSnapshot(), allowedPendingKeys,
      allowUnreconciledFirstAttempt: true });
    const request = await observeImportQuietWindow({ anidbId: 42,
      episodeIds: [1001], readActivity: async () => ({
        state: 'quiet_observed', fingerprint: 'a'.repeat(64),
        unrelatedPendingKeys: [] }),
      readFeedState: readFeed, readScopedFeedState: readFeed,
      wait: async () => { clock += 120_000; }, now: () => clock,
      requireFingerprint: true });
    assert.equal(request.state, 'quiet_window_observed');
    assert.equal(consumer.getState().fullReconciliationNeeded, true);
    assert.equal(timers.values().next().value.delay, 86_400_000);
  } finally { await scheduler.close(); await consumer.close(); ledger.close();
    await rm(dir, { recursive: true, force: true }); }
});

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
