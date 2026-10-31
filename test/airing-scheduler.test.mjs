import assert from 'node:assert/strict';
import test from 'node:test';
import { createAiringScheduler } from '../src/requests/airing-scheduler.mjs';

function fakeTimers() {
  const timers = new Map();
  let nextId = 1;
  return {
    timers,
    setTimeoutImpl(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeoutImpl(id) { timers.delete(id); },
    async fire() {
      const [id, timer] = timers.entries().next().value;
      timers.delete(id);
      await timer.callback();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

test('scheduler paces pages, waits after a full pass, and backs off on failure', async () => {
  const clock = fakeTimers();
  const results = [
    { state: 'page', afterId: 3 },
    { state: 'page', afterId: 0 },
    { state: 'held', reason: 'provider_unavailable' },
  ];
  let calls = 0;
  const scheduler = createAiringScheduler({ runPage: async () => { calls++; return results.shift(); },
    initialDelayMs: 100, pageDelayMs: 200, cycleDelayMs: 300, failureDelayMs: 400,
    ...clock });
  scheduler.start();
  assert.equal([...clock.timers.values()][0].delay, 100);
  await clock.fire();
  assert.equal([...clock.timers.values()][0].delay, 200);
  await clock.fire();
  assert.equal([...clock.timers.values()][0].delay, 300);
  await clock.fire();
  assert.equal([...clock.timers.values()][0].delay, 400);
  assert.equal(calls, 3);
  await scheduler.stop();
  assert.equal(clock.timers.size, 0);
});

test('stop drains an in-flight page and never schedules another', async () => {
  const clock = fakeTimers();
  let release;
  const scheduler = createAiringScheduler({ runPage: () => new Promise((resolve) => { release = resolve; }),
    initialDelayMs: 100, ...clock });
  scheduler.start();
  const firing = clock.fire();
  await new Promise((resolve) => setImmediate(resolve));
  let stopped = false;
  const stopping = scheduler.stop().then(() => { stopped = true; });
  assert.equal(stopped, false);
  release({ state: 'page', afterId: 2 });
  await firing;
  await stopping;
  assert.equal(clock.timers.size, 0);
  assert.equal(stopped, true);
});
