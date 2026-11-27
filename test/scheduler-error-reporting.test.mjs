import assert from 'node:assert/strict';
import test from 'node:test';
import { createDirectAvailabilityScheduler } from
  '../src/availability/direct-availability-scheduler.mjs';
import { createAiringScheduler } from '../src/requests/airing-scheduler.mjs';

// Fake timers: each scheduled callback is queued and run by hand.
function fakeTimers() {
  const queue = [];
  return {
    queue,
    setTimer: (callback, delay) => { queue.push({ callback, delay }); return queue.length; },
    clearTimer: () => {},
    async runNext() { const next = queue.shift(); await next.callback(); return next.delay; },
  };
}

test('a failing availability tick is reported and the loop keeps running', async () => {
  const timers = fakeTimers();
  const reported = [];
  let calls = 0;
  const scheduler = createDirectAvailabilityScheduler({
    runOnce: async () => {
      calls++;
      if (calls === 1) throw new Error('synthetic tick failure');
      return { state: 'checked' };
    },
    name: 'test cycle', onError: (error) => reported.push(error.message),
    initialDelayMs: 1_000, activeDelayMs: 10_000, idleDelayMs: 60_000,
    setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  scheduler.start();
  await timers.runNext();
  assert.deepEqual(reported, ['synthetic tick failure']);
  assert.equal(timers.queue.length, 1, 'next tick scheduled after a failure');
  assert.equal(timers.queue[0].delay, 60_000);
  await timers.runNext();
  assert.equal(calls, 2);
  assert.equal(timers.queue[0].delay, 10_000);
  await scheduler.close();
});

test('a throwing error reporter cannot stop the availability loop', async () => {
  const timers = fakeTimers();
  const scheduler = createDirectAvailabilityScheduler({
    runOnce: async () => { throw new Error('tick'); },
    onError: () => { throw new Error('reporter'); },
    initialDelayMs: 1_000, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  scheduler.start();
  await timers.runNext();
  assert.equal(timers.queue.length, 1);
  await scheduler.close();
});

test('the default availability reporter names the scheduler', async () => {
  const timers = fakeTimers();
  const written = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => { written.push(String(chunk)); return true; };
  try {
    const scheduler = createDirectAvailabilityScheduler({
      runOnce: async () => { throw new Error('synthetic'); }, name: 'pending title',
      initialDelayMs: 1_000, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
    scheduler.start();
    await timers.runNext();
    await scheduler.close();
  } finally { process.stderr.write = original; }
  assert.match(written.join(''), /Negev pending title tick failed: Error: synthetic/);
});

test('a failing airing poll is reported and retried after the failure delay', async () => {
  const timers = fakeTimers();
  const reported = [];
  const scheduler = createAiringScheduler({
    runPage: async () => { throw new Error('synthetic poll failure'); },
    onError: (error) => reported.push(error.message),
    initialDelayMs: 1, failureDelayMs: 300_000,
    setTimeoutImpl: timers.setTimer, clearTimeoutImpl: timers.clearTimer });
  scheduler.start();
  await timers.runNext();
  assert.deepEqual(reported, ['synthetic poll failure']);
  assert.equal(timers.queue.at(-1)?.delay, 300_000);
  await scheduler.stop();
});
