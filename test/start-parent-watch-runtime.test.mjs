import assert from 'node:assert/strict';
import test from 'node:test';
import { startParentWatchRuntime } from '../src/requests/start-parent-watch-runtime.mjs';

test('parent-watch runtime is inert unless explicitly enabled', async () => {
  const result = startParentWatchRuntime({ config: { parentWatch: false },
    openParents: () => { throw new Error('unexpected open'); } });
  assert.equal(result, null);
});

test('enabled runtime starts a paced worker and closes ledgers after its scheduler', async () => {
  const events = [];
  const parent = { close() { events.push('parent-close'); } };
  const requests = { close() { events.push('request-close'); } };
  const runtime = startParentWatchRuntime({
    config: { parentWatch: true, dbPath: '/private/negev.sqlite',
      shokoBaseUrl: 'http://shoko:8111', timeZone: 'Australia/Sydney' },
    shokoApiKey: 'private',
    openParents: (path) => { assert.equal(path, '/private/negev.sqlite'); return parent; },
    openRequests: () => requests,
    createWorker: (input) => {
      assert.equal(input.parents, parent);
      assert.equal(input.requests, requests);
      assert.equal(typeof input.loadDetail, 'function');
      assert.equal(typeof input.readRelations, 'function');
      return { runOnce: async () => ({ state: 'page', afterId: 0 }) };
    },
    createScheduler: ({ runPage, pageDelayMs, cycleDelayMs }) => {
      assert.equal(typeof runPage, 'function');
      assert.equal(pageDelayMs, 300_000);
      assert.equal(cycleDelayMs, 86_400_000);
      return { start() { events.push('start'); },
        async stop() { events.push('stop'); } };
    },
  });
  assert.deepEqual(events, ['start']);
  await runtime.close();
  assert.deepEqual(events, ['start', 'stop', 'parent-close', 'request-close']);
});

test('failed startup closes both opened ledgers', () => {
  const events = [];
  assert.throws(() => startParentWatchRuntime({
    config: { parentWatch: true, dbPath: '/private/negev.sqlite',
      shokoBaseUrl: 'http://shoko:8111', timeZone: 'Australia/Sydney' },
    shokoApiKey: 'private',
    openParents: () => ({ close() { events.push('parent-close'); } }),
    openRequests: () => ({ close() { events.push('request-close'); } }),
    createWorker: () => { throw new Error('worker failed'); },
  }), /worker failed/);
  assert.deepEqual(events, ['request-close', 'parent-close']);
});
