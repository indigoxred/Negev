import assert from 'node:assert/strict';
import test from 'node:test';
import { createDirectAvailabilityScheduler } from
  '../src/availability/direct-availability-scheduler.mjs';

test('direct availability runner is opt-in, serial, paced, and drains on stop', async () => {
  const timers = [];
  let resolveCheck;
  let calls = 0;
  const scheduler = createDirectAvailabilityScheduler({
    runOnce: () => { calls++; return new Promise((resolve) => {
      resolveCheck = resolve;
    }); },
    setTimer: (fn, delay) => { timers.push({ fn, delay }); return timers.length; },
    clearTimer: () => {},
  });
  assert.equal(calls, 0);
  scheduler.start();
  assert.equal(timers[0].delay, 60_000);
  const running = timers.shift().fn();
  assert.equal(calls, 1);
  let stopped = false;
  const closing = scheduler.close().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  resolveCheck({ state: 'checked' });
  await running;
  await closing;
  assert.equal(stopped, true);
  assert.equal(timers.length, 0);
});

test('title progress keeps the shared scheduler paced at one minute', async () => {
  const timers = [];
  const scheduler = createDirectAvailabilityScheduler({
    runOnce: async () => ({ state: 'page_loaded' }),
    idleDelayMs: 60_000,
    setTimer: (fn, delay) => { timers.push({ fn, delay }); return timers.length; },
    clearTimer: () => {},
  });
  scheduler.start();
  await timers.shift().fn();
  assert.equal(timers[0].delay, 60_000);
  await scheduler.close();
});

test('a configured active pace advances a backlog without overlapping checks', async () => {
  const timers = [];
  const scheduler = createDirectAvailabilityScheduler({
    runOnce: async () => ({ state: 'checked' }),
    activeDelayMs: 15_000,
    setTimer: (fn, delay) => { timers.push({ fn, delay }); return timers.length; },
    clearTimer: () => {},
  });
  scheduler.start();
  await timers.shift().fn();
  assert.equal(timers[0].delay, 15_000);
  await scheduler.close();
});

test('active pace cannot exceed the bounded 10-second to five-minute range', () => {
  for (const activeDelayMs of [0, 9_999, 300_001, NaN, '15000']) {
    assert.throws(() => createDirectAvailabilityScheduler({
      runOnce: async () => ({ state: 'checked' }), activeDelayMs,
    }), TypeError);
  }
});
