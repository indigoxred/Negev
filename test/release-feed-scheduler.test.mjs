import assert from 'node:assert/strict';
import test from 'node:test';
import { createReleaseFeedScheduler } from '../src/acquisition/release-feed-scheduler.mjs';

test('one hourly cycle reads each installed indexer once and never downloads', async () => {
  const calls = [];
  const timers = [];
  const scheduler = createReleaseFeedScheduler({ indexerIds: [5, 6],
    feedLedger: { getPollIntervalMs: () => 3_600_000,
      accept: (value) => { calls.push(['accept', value.indexerId]);
        return { state: 'processed', newItems: 1, wokenRequests: 1 }; } },
    readFeed: async (indexerId) => { calls.push(['read', indexerId]);
      return { state: 'feed', items: [] }; },
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: () => {} });
  scheduler.start();
  assert.equal(timers[0].ms, 60_000);
  await timers.shift().fn();
  assert.deepEqual(calls, [['read', 5], ['accept', 5],
    ['read', 6], ['accept', 6]]);
  assert.equal(timers.at(-1).ms, 3_600_000);
  await scheduler.stop();
});

test('no active watches cause no feed request and rate limits back off', async () => {
  const timers = [];
  let interval = null;
  let reads = 0;
  const scheduler = createReleaseFeedScheduler({ indexerIds: [5],
    feedLedger: { getPollIntervalMs: () => interval,
      accept: () => { throw Error('must not accept failed feed'); } },
    readFeed: async () => { reads++; return { state: 'unavailable',
      retryAfterMs: 120_000 }; },
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: () => {} });
  scheduler.start();
  await timers.shift().fn();
  assert.equal(reads, 0);
  assert.equal(timers.at(-1).ms, 60_000);
  interval = 3_600_000;
  await timers.shift().fn();
  assert.equal(reads, 1);
  assert.equal(timers.at(-1).ms, 3_600_000);
  await scheduler.stop();
});

test('a new airing watch shortens an existing far-future feed schedule', async () => {
  const timers = [];
  let clock = 60_000;
  let interval = 86_400_000;
  let reads = 0;
  const scheduler = createReleaseFeedScheduler({ indexerIds: [5],
    now: () => clock,
    feedLedger: { getPollIntervalMs: () => interval,
      accept: () => ({ state: 'processed', newItems: 0, wokenRequests: 0 }) },
    readFeed: async () => { reads++; return { state: 'feed', items: [] }; },
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: () => {} });
  scheduler.start();
  await timers.shift().fn();
  assert.equal(reads, 1);
  assert.ok(timers.at(-1).ms <= 3_600_000);
  interval = 3_600_000;
  clock += 3_600_000;
  await timers.shift().fn();
  assert.equal(reads, 2);
  await scheduler.stop();
});
