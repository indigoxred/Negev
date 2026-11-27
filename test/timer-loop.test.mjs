import assert from 'node:assert/strict';
import test from 'node:test';
import { createTimerLoop } from '../src/runtime/timer-loop.mjs';

function fakeTimers() {
  const queue = [];
  return { queue,
    setTimer: (callback, delay) => { const entry = { callback, delay }; queue.push(entry); return entry; },
    clearTimer: (entry) => { const index = queue.indexOf(entry); if (index >= 0) queue.splice(index, 1); },
    runNext: () => queue.shift().callback() };
}

test('the loop waits the delay each step returns', async () => {
  const timers = fakeTimers();
  const delays = [10, 20];
  const loop = createTimerLoop({ run: async () => delays.shift(), ...timers });
  assert.equal(loop.start(5), true);
  assert.equal(loop.start(5), false, 'a second start does nothing');
  assert.deepEqual(timers.queue.map((entry) => entry.delay), [5]);
  await timers.runNext();
  assert.deepEqual(timers.queue.map((entry) => entry.delay), [10]);
  await timers.runNext();
  assert.deepEqual(timers.queue.map((entry) => entry.delay), [20]);
  await timers.runNext();
  assert.equal(timers.queue.length, 0, 'a non-number result stops scheduling');
});

test('a throwing step is reported and retried after the failure delay', async () => {
  const timers = fakeTimers();
  const errors = [];
  const loop = createTimerLoop({ run: async () => { throw new Error('boom'); },
    failureDelayMs: 99, onError: (error) => errors.push(error.message), ...timers });
  loop.start(1);
  await timers.runNext();
  assert.deepEqual(errors, ['boom']);
  assert.deepEqual(timers.queue.map((entry) => entry.delay), [99]);
});

test('close waits for the running step and prevents rescheduling', async () => {
  const timers = fakeTimers();
  let release;
  const loop = createTimerLoop({ ...timers,
    run: () => new Promise((resolve) => { release = () => resolve(10); }) });
  loop.start(1);
  const running = timers.runNext();
  assert.equal(loop.running, true);
  let closed = false;
  const closing = loop.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false, 'close waits for the step in flight');
  release();
  await running;
  await closing;
  assert.equal(closed, true);
  assert.equal(timers.queue.length, 0);
  assert.equal(loop.start(1), false, 'a closed loop cannot restart');
});

test('reschedule replaces the pending wait', async () => {
  const timers = fakeTimers();
  const loop = createTimerLoop({ run: async () => 50, ...timers });
  loop.start(1000);
  assert.equal(loop.scheduledDelay, 1000);
  assert.equal(loop.reschedule(10), true);
  assert.deepEqual(timers.queue.map((entry) => entry.delay), [10]);
  await loop.close();
  assert.equal(loop.reschedule(10), false);
});
