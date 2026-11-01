import assert from 'node:assert/strict';
import test from 'node:test';
import { createFileBackfillScheduler } from
  '../src/availability/file-backfill-scheduler.mjs';

const fakeClock = () => {
  const timers = new Map();
  let next = 0;
  return { timers,
    setTimer(callback, delay) { const id = ++next;
      timers.set(id, { callback, delay }); return id; },
    clearTimer(id) { timers.delete(id); },
    async fire() { const [id, timer] = timers.entries().next().value;
      timers.delete(id); await timer.callback(); },
  };
};

test('file backfill waits one interval and never overlaps its bounded tick', async () => {
  const clock = fakeClock();
  let resolve;
  let calls = 0;
  const scheduler = createFileBackfillScheduler({
    tick: () => { calls++; return new Promise((done) => { resolve = done; }); },
    ...clock });
  scheduler.start();
  assert.equal(calls, 0);
  assert.equal(clock.timers.values().next().value.delay, 60_000);
  const running = clock.fire();
  assert.equal(calls, 1);
  assert.deepEqual(await scheduler.runOnce(),
    { state: 'held', reason: 'file_backfill_busy' });
  assert.equal(clock.timers.size, 0);
  resolve({ state: 'checked' });
  await running;
  assert.equal(clock.timers.values().next().value.delay, 60_000);
  await scheduler.close();
  assert.equal(clock.timers.size, 0);
});

test('file backfill backs off on failed or empty ticks and closes cleanly', async () => {
  const clock = fakeClock();
  let result = { state: 'held', reason: 'provider_unavailable' };
  const scheduler = createFileBackfillScheduler({
    tick: async () => result, ...clock });
  scheduler.start();
  await clock.fire();
  assert.equal(clock.timers.values().next().value.delay, 5 * 60_000);
  result = { state: 'idle' };
  await clock.fire();
  assert.equal(clock.timers.values().next().value.delay, 5 * 60_000);
  await scheduler.close();
  assert.deepEqual(await scheduler.runOnce(),
    { state: 'held', reason: 'file_backfill_closed' });
});

test('a measured faster interval is configurable but remains bounded', () => {
  const clock = fakeClock();
  const scheduler = createFileBackfillScheduler({
    tick: async () => ({ state: 'checked' }), intervalMs: 10_000,
    failureDelayMs: 5 * 60_000, ...clock });
  scheduler.start();
  assert.equal(clock.timers.values().next().value.delay, 10_000);
  assert.throws(() => createFileBackfillScheduler({
    tick: async () => ({ state: 'checked' }), intervalMs: 9_999 }),
  TypeError);
  void scheduler.close();
});
