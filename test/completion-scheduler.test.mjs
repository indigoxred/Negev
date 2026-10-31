import assert from 'node:assert/strict';
import test from 'node:test';
import { createCompletionScheduler } from '../src/acquisition/completion-scheduler.mjs';

function clock() {
  const scheduled = new Map();
  let nextId = 1;
  return {
    scheduled,
    setTimer(callback, delay) {
      const id = nextId++;
      scheduled.set(id, { callback, delay });
      return id;
    },
    clearTimer(id) { scheduled.delete(id); },
    async advance() {
      const [id, task] = scheduled.entries().next().value;
      scheduled.delete(id);
      await task.callback();
    },
    delays() { return [...scheduled.values()].map((task) => task.delay); },
  };
}

test('completion checks start after a delay and never burst through a backlog', async () => {
  const timer = clock();
  let calls = 0;
  const scheduler = createCompletionScheduler({
    runOnce: async () => { calls++; return calls === 3
      ? { state: 'pass_complete' } : { state: 'processed' }; },
    setTimer: timer.setTimer, clearTimer: timer.clearTimer,
  });
  scheduler.start();
  assert.equal(calls, 0);
  assert.deepEqual(timer.delays(), [60_000]);
  await timer.advance();
  assert.equal(calls, 1);
  assert.deepEqual(timer.delays(), [60_000]);
  await timer.advance();
  assert.equal(calls, 2);
  await timer.advance();
  assert.deepEqual(timer.delays(), [30 * 60_000]);
  await scheduler.stop();
  assert.deepEqual(timer.delays(), []);
});

test('shutdown waits for an active check and schedules no later work', async () => {
  const timer = clock();
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const scheduler = createCompletionScheduler({ runOnce: () => pending,
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

test('failure waits before retry and a second start is rejected', async () => {
  const timer = clock();
  const scheduler = createCompletionScheduler({ runOnce: async () => {
    throw new Error('provider down'); },
    setTimer: timer.setTimer, clearTimer: timer.clearTimer });
  scheduler.start();
  assert.throws(() => scheduler.start(), /already started/);
  await timer.advance();
  assert.deepEqual(timer.delays(), [5 * 60_000]);
  await scheduler.stop();
});
