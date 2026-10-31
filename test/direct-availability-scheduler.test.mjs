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
