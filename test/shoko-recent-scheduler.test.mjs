import assert from 'node:assert/strict';
import test from 'node:test';
import { createShokoRecentScheduler } from
  '../src/availability/shoko-recent-scheduler.mjs';

function fakeClock() {
  const timers = new Map();
  let next = 0;
  return {
    timers,
    setTimer(callback, delay) {
      const id = ++next;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimer(id) { timers.delete(id); },
    async fire() {
      const [id, timer] = timers.entries().next().value;
      timers.delete(id);
      await timer.callback();
    },
    delay() { return timers.values().next().value?.delay; },
  };
}

test('disabled start makes no Shoko call and a gap schedules one delayed scan', async () => {
  const clock = fakeClock();
  const calls = [];
  const scheduler = createShokoRecentScheduler({
    scan: async () => { calls.push('scan'); return { state: 'caught_up', added: 0 }; },
    drainOne: async () => { calls.push('drain'); return { state: 'idle' }; },
    ...clock,
  });
  scheduler.requestSoon();
  assert.equal(clock.timers.size, 0);
  assert.deepEqual(calls, []);
  scheduler.start();
  assert.equal(clock.delay(), 30 * 60_000);
  scheduler.requestSoon();
  assert.equal(clock.timers.size, 1);
  assert.equal(clock.delay(), 60_000);
  const firstGapTimer = clock.timers.keys().next().value;
  scheduler.requestSoon();
  assert.equal(clock.timers.keys().next().value, firstGapTimer);
  await clock.fire();
  assert.deepEqual(calls, ['scan']);
  assert.equal(clock.delay(), 10_000);
  await clock.fire();
  assert.deepEqual(calls, ['scan', 'drain']);
  assert.equal(clock.delay(), 30 * 60_000);
  await scheduler.close();
});

test('a running scan cannot overlap another scan or drain and closes cleanly', async () => {
  const clock = fakeClock();
  let release;
  const calls = [];
  const scheduler = createShokoRecentScheduler({
    scan: () => { calls.push('scan'); return new Promise((done) => { release = done; }); },
    drainOne: async () => { calls.push('drain'); return { state: 'idle' }; },
    ...clock,
  });
  scheduler.start();
  const running = clock.fire();
  scheduler.requestSoon();
  assert.deepEqual(calls, ['scan']);
  assert.equal(clock.timers.size, 0);
  let stopped = false;
  const closing = scheduler.close().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  release({ state: 'caught_up', added: 1 });
  await running;
  await closing;
  assert.equal(clock.timers.size, 0);
  assert.deepEqual(calls, ['scan']);
});

test('pending files drain one at a time and a gap gets a scan within a minute', async () => {
  const clock = fakeClock();
  const calls = [];
  const scheduler = createShokoRecentScheduler({
    scan: async () => { calls.push('scan'); return { state: 'caught_up', added: 2 }; },
    drainOne: async () => {
      calls.push('drain');
      return calls.filter((call) => call === 'drain').length < 3 ?
        { state: 'acknowledged' } : { state: 'idle' };
    },
    ...clock,
  });
  scheduler.start();
  await clock.fire();
  await clock.fire();
  assert.deepEqual(calls, ['scan', 'drain']);
  assert.equal(clock.delay(), 10_000);
  scheduler.requestSoon();
  assert.equal(clock.delay(), 60_000);
  await clock.fire();
  assert.deepEqual(calls, ['scan', 'drain', 'scan']);
  await scheduler.close();
});

test('a failed scan still drains durable work and retries the scan sooner', async () => {
  const clock = fakeClock();
  const calls = [];
  const scheduler = createShokoRecentScheduler({
    scan: async () => { calls.push('scan'); return { state: 'held' }; },
    drainOne: async () => { calls.push('drain'); return { state: 'idle' }; },
    ...clock,
  });
  scheduler.start();
  await clock.fire();
  assert.equal(clock.delay(), 10_000);
  await clock.fire();
  assert.deepEqual(calls, ['scan', 'drain']);
  assert.equal(scheduler.getState().state, 'held');
  assert.equal(clock.delay(), 5 * 60_000);
  await scheduler.close();
});
