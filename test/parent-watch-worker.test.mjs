import assert from 'node:assert/strict';
import test from 'node:test';
import { createParentWatchWorker } from '../src/requests/parent-watch-worker.mjs';

test('one tick reconciles one parent and advances the durable cursor', async () => {
  const events = [];
  const parents = {
    getCursor: () => 0,
    listActive: () => [{ tvdbId: 100, requesterId: 7, sourceSeriesId: 42 }],
    advanceCursor: (input) => { events.push(input); return { state: 'advanced' }; },
  };
  const worker = createParentWatchWorker({ parents,
    mapReader: { read: async () => ({ version: 2, anime: [] }) },
    reconcile: async () => ({ state: 'reconciled', created: [], existing: [], skipped: [] }),
    requests: {}, loadDetail: async () => {}, readRelations: async () => {},
    today: () => '2026-11-12', now: () => 1000 });
  assert.deepEqual(await worker.runOnce(), { state: 'page', afterId: 100,
    result: { state: 'reconciled', created: [], existing: [], skipped: [] } });
  assert.deepEqual(events, [{ expectedTvdbId: 0, nextTvdbId: 100 }]);
});

test('a map outage keeps the cursor and fails closed', async () => {
  let advanced = false;
  const worker = createParentWatchWorker({
    parents: { getCursor: () => 0,
      listActive: () => [{ tvdbId: 100, requesterId: 7, sourceSeriesId: 42 }],
      advanceCursor: () => { advanced = true; } },
    mapReader: { read: async () => { throw new Error('offline'); } },
    reconcile: async () => { throw new Error('must not run'); },
    requests: {}, loadDetail: async () => {}, readRelations: async () => {},
    today: () => '2026-11-12', now: () => 1000 });
  assert.deepEqual(await worker.runOnce(), { state: 'held',
    reason: 'parent_map_unavailable' });
  assert.equal(advanced, false);
});

test('a complete parent page wraps and awaits the next cycle', async () => {
  const events = [];
  const worker = createParentWatchWorker({
    parents: { getCursor: () => 100, listActive: () => [],
      advanceCursor: (input) => { events.push(input); return { state: 'advanced' }; } },
    mapReader: { read: async () => { throw new Error('not needed'); } },
    reconcile: async () => { throw new Error('not needed'); },
    requests: {}, loadDetail: async () => {}, readRelations: async () => {},
    today: () => '2026-11-12', now: () => 1000 });
  assert.deepEqual(await worker.runOnce(), { state: 'page', afterId: 0 });
  assert.deepEqual(events, [{ expectedTvdbId: 100, nextTvdbId: 0 }]);
});
