import test from 'node:test';
import assert from 'node:assert/strict';
import { createShokoInventoryScheduler } from
  '../src/availability/shoko-inventory-scheduler.mjs';

function fakeClock() {
  const timers = new Map();
  let next = 0;
  return {
    timers,
    setTimer(callback, delay) { const id = ++next; timers.set(id, { callback, delay }); return id; },
    clearTimer(id) { timers.delete(id); },
    async fire() {
      const [id, timer] = timers.entries().next().value;
      timers.delete(id);
      await timer.callback();
    },
  };
}

test('scheduler reads one Shoko page per timer and rests after a full pass', async () => {
  const clock = fakeClock();
  let calls = 0;
  const scheduler = createShokoInventoryScheduler({
    tick: async () => ({ state: 'recorded', nextPage: ++calls === 2 ? 1 : 2 }),
    ...clock,
  });
  scheduler.start();
  assert.equal(clock.timers.values().next().value.delay, 60_000);
  assert.equal(calls, 0);
  await clock.fire();
  assert.equal(calls, 1);
  assert.equal(scheduler.getState().active, false);
  assert.equal(clock.timers.values().next().value.delay, 60_000);
  await clock.fire();
  assert.equal(calls, 2);
  assert.equal(clock.timers.values().next().value.delay, 24 * 60 * 60_000);
  await scheduler.close();
  assert.equal(clock.timers.size, 0);
});

test('provider failure backs off and never overlaps another page', async () => {
  const clock = fakeClock();
  let resolve;
  let calls = 0;
  const scheduler = createShokoInventoryScheduler({ tick: async () => {
    calls++;
    return new Promise((done) => { resolve = done; });
  }, ...clock });
  scheduler.start();
  const running = clock.fire();
  assert.equal(calls, 1);
  assert.equal(clock.timers.size, 0);
  resolve({ state: 'held', reason: 'file_page_unavailable' });
  await running;
  assert.equal(clock.timers.values().next().value.delay, 5 * 60_000);
  await scheduler.close();
});

test('an invalid full-pass page retries after five minutes, not a day', async () => {
  const clock = fakeClock();
  const scheduler = createShokoInventoryScheduler({
    tick: async () => ({ state: 'held', reason: 'invalid_file_pass' }),
    ...clock,
  });
  scheduler.start();
  await clock.fire();
  assert.equal(clock.timers.values().next().value.delay, 5 * 60_000);
  await scheduler.close();
});

test('delivered change receipts resume the paced page loop without failure backoff', async () => {
  const clock = fakeClock();
  const scheduler = createShokoInventoryScheduler({
    tick: async () => ({ state: 'delivered', count: 1 }), ...clock,
  });
  scheduler.start();
  await clock.fire();
  assert.equal(clock.timers.values().next().value.delay, 60_000);
  await scheduler.close();
});

test('a feed gap restarts a rested inventory pass within one minute', async () => {
  const clock = fakeClock();
  const scheduler = createShokoInventoryScheduler({
    tick: async () => ({ state: 'recorded', nextPage: 1 }), ...clock,
  });
  scheduler.start();
  await clock.fire();
  assert.equal(clock.timers.values().next().value.delay, 24 * 60 * 60_000);
  scheduler.requestSoon();
  assert.equal(clock.timers.size, 1);
  assert.equal(clock.timers.values().next().value.delay, 60_000);
  await scheduler.close();
});

test('a feed gap during a page advances the next page without overlap', async () => {
  const clock = fakeClock();
  let resolve;
  const scheduler = createShokoInventoryScheduler({
    tick: () => new Promise((done) => { resolve = done; }), ...clock,
  });
  scheduler.start();
  const running = clock.fire();
  scheduler.requestSoon();
  assert.equal(clock.timers.size, 0);
  resolve({ state: 'recorded', nextPage: 1 });
  await running;
  assert.equal(clock.timers.values().next().value.delay, 60_000);
  await scheduler.close();
});

test('shutdown cancels future work and drains the active page', async () => {
  const clock = fakeClock();
  let resolve;
  const scheduler = createShokoInventoryScheduler({ tick: () =>
    new Promise((done) => { resolve = done; }), ...clock });
  scheduler.start();
  const running = clock.fire();
  let closed = false;
  const closing = scheduler.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  resolve({ state: 'recorded', nextPage: 2 });
  await running;
  await closing;
  assert.equal(clock.timers.size, 0);
});
