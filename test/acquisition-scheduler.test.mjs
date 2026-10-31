import assert from 'node:assert/strict';
import test from 'node:test';
import { createAcquisitionScheduler } from '../src/acquisition/acquisition-scheduler.mjs';

function clock() {
  const timers = new Map();
  let nextId = 0;
  return {
    timers,
    setTimer(callback, delay) {
      const id = ++nextId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimer(id) { timers.delete(id); },
    async fire() {
      const [id, timer] = timers.entries().next().value;
      timers.delete(id);
      await timer.callback();
    },
  };
}

test('paces bounded acquisition pages and rests after a complete pass', async () => {
  const time = clock();
  const outcomes = [{ state: 'page', results: [] },
    { state: 'pass_complete', pass: 1, results: [] },
    { state: 'held', reason: 'queue_unavailable' }];
  let calls = 0;
  const scheduler = createAcquisitionScheduler({ runPage: async () => {
    calls++;
    return outcomes.shift();
  }, ...time });
  scheduler.start();
  assert.equal(calls, 0);
  assert.equal([...time.timers.values()][0].delay, 60_000);
  await time.fire();
  assert.equal([...time.timers.values()][0].delay, 60_000);
  await time.fire();
  assert.equal([...time.timers.values()][0].delay, 30 * 60_000);
  await time.fire();
  assert.equal([...time.timers.values()][0].delay, 5 * 60_000);
  assert.equal(calls, 3);
  await scheduler.stop();
});

test('stop drains one active page and cancels later acquisition work', async () => {
  const time = clock();
  let resolve;
  let calls = 0;
  const scheduler = createAcquisitionScheduler({ runPage: () => {
    calls++;
    return new Promise((done) => { resolve = done; });
  }, ...time });
  scheduler.start();
  const firing = time.fire();
  await Promise.resolve();
  let stopped = false;
  const stopping = scheduler.stop().then(() => { stopped = true; });
  assert.equal(stopped, false);
  resolve({ state: 'page', results: [] });
  await firing;
  await stopping;
  assert.equal(calls, 1);
  assert.equal(time.timers.size, 0);
});
