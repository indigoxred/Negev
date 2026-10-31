import assert from 'node:assert/strict';
import test from 'node:test';
import { createHandoffPublishScheduler } from
  '../src/acquisition/handoff-publish-scheduler.mjs';

function clock() {
  const jobs = new Map();
  let id = 0;
  return {
    setTimer(callback, delay) { jobs.set(++id, { callback, delay }); return id; },
    clearTimer(key) { jobs.delete(key); },
    async advance() {
      const [key, job] = jobs.entries().next().value;
      jobs.delete(key);
      await job.callback();
    },
    delays() { return [...jobs.values()].map((job) => job.delay); },
  };
}

test('publish ticks one batch at a time and rests when idle', async () => {
  const timer = clock();
  let calls = 0;
  const scheduler = createHandoffPublishScheduler({
    runOnce: async () => ++calls === 1 ? { state: 'processed' } : { state: 'idle' },
    setTimer: timer.setTimer, clearTimer: timer.clearTimer,
  });
  scheduler.start();
  assert.equal(calls, 0);
  assert.deepEqual(timer.delays(), [60_000]);
  await timer.advance();
  assert.equal(calls, 1);
  assert.deepEqual(timer.delays(), [60_000]);
  await timer.advance();
  assert.deepEqual(timer.delays(), [5 * 60_000]);
  await scheduler.stop();
  assert.deepEqual(timer.delays(), []);
});

test('publish shutdown waits for the current batch and schedules no further read', async () => {
  const timer = clock();
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const scheduler = createHandoffPublishScheduler({ runOnce: () => pending,
    setTimer: timer.setTimer, clearTimer: timer.clearTimer });
  scheduler.start();
  const active = timer.advance();
  let stopped = false;
  const close = scheduler.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  release({ state: 'processed' });
  await Promise.all([active, close]);
  assert.equal(stopped, true);
  assert.deepEqual(timer.delays(), []);
});
