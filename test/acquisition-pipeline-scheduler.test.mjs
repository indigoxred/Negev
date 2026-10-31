import assert from 'node:assert/strict';
import test from 'node:test';
import { createPipelineScheduler } from
  '../src/acquisition/acquisition-pipeline-scheduler.mjs';

function clock() {
  const jobs = new Map();
  let nextId = 0;
  return {
    setTimer(callback, delay) { jobs.set(++nextId, { callback, delay }); return nextId; },
    clearTimer(id) { jobs.delete(id); },
    async advance() {
      const [id, job] = jobs.entries().next().value;
      jobs.delete(id);
      await job.callback();
    },
    delays() { return [...jobs.values()].map((job) => job.delay); },
  };
}

test('one paced clock reconciles first and visits all four stages without overlap', async () => {
  const timer = clock();
  const calls = [];
  const pipeline = {
    initialize: async () => { calls.push('reconcile'); return { state: 'reconciled' }; },
    tickPublish: async () => { calls.push('publish'); return { state: 'idle' }; },
    tickCompletions: async () => { calls.push('completion'); return { state: 'idle' }; },
    tickStarts: async () => { calls.push('start'); return { state: 'idle' }; },
    tickRequests: async () => { calls.push('request'); return { state: 'pass_complete' }; },
    close: async () => { calls.push('close'); },
  };
  const scheduler = createPipelineScheduler({ pipeline,
    setTimer: timer.setTimer, clearTimer: timer.clearTimer });
  assert.deepEqual(await scheduler.start(), { state: 'reconciled' });
  assert.deepEqual(calls, ['reconcile']);
  assert.deepEqual(timer.delays(), [60_000]);
  for (let i = 0; i < 4; i++) await timer.advance();
  assert.deepEqual(calls, ['reconcile', 'publish', 'completion', 'start', 'request']);
  assert.deepEqual(timer.delays(), [60_000]);
  await scheduler.stop();
  assert.deepEqual(timer.delays(), []);
  assert.equal(calls.at(-1), 'close');
});

test('shutdown drains an active stage and never starts another stage', async () => {
  const timer = clock();
  let release;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const pending = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const pipeline = {
    initialize: async () => ({ state: 'reconciled' }),
    tickPublish: async () => { entered(); await pending;
      calls.push('publish'); return { state: 'processed' }; },
    tickCompletions: async () => { calls.push('completion'); },
    tickStarts: async () => { calls.push('start'); },
    tickRequests: async () => { calls.push('request'); },
    close: async () => { calls.push('close'); },
  };
  const scheduler = createPipelineScheduler({ pipeline,
    setTimer: timer.setTimer, clearTimer: timer.clearTimer });
  await scheduler.start();
  const inFlight = timer.advance();
  await started;
  let stopped = false;
  const stopping = scheduler.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  release();
  await Promise.all([inFlight, stopping]);
  assert.deepEqual(calls, ['publish', 'close']);
  assert.deepEqual(timer.delays(), []);
});

test('failed reconciliation never schedules work', async () => {
  const timer = clock();
  let closed = false;
  const pipeline = {
    initialize: async () => ({ state: 'held', reason: 'reconciliation_unavailable' }),
    tickPublish: async () => { throw new Error('must not tick'); },
    tickCompletions: async () => { throw new Error('must not tick'); },
    tickStarts: async () => { throw new Error('must not tick'); },
    tickRequests: async () => { throw new Error('must not tick'); },
    close: async () => { closed = true; },
  };
  const scheduler = createPipelineScheduler({ pipeline,
    setTimer: timer.setTimer, clearTimer: timer.clearTimer });
  assert.deepEqual(await scheduler.start(),
    { state: 'held', reason: 'reconciliation_unavailable' });
  assert.deepEqual(timer.delays(), []);
  await scheduler.stop();
  assert.equal(closed, true);
});

test('operator status distinguishes waiting, active work and a stopped worker', async () => {
  const timer = clock();
  let release;
  let entered;
  const active = new Promise((resolve) => { entered = resolve; });
  const pending = new Promise((resolve) => { release = resolve; });
  const pipeline = {
    initialize: async () => ({ state: 'reconciled' }),
    tickPublish: async () => { entered(); await pending; return { state: 'processed' }; },
    tickCompletions: async () => ({ state: 'idle' }),
    tickStarts: async () => ({ state: 'idle' }),
    tickRequests: async () => ({ state: 'pass_complete' }),
    close: async () => {},
  };
  const scheduler = createPipelineScheduler({ pipeline, now: () => 1234,
    setTimer: timer.setTimer, clearTimer: timer.clearTimer });
  assert.deepEqual(scheduler.getStatus(), { state: 'not_started',
    activeStage: null, lastStage: null, lastResult: null,
    lastFinishedMs: null });
  await scheduler.start();
  assert.equal(scheduler.getStatus().state, 'waiting');
  const firing = timer.advance();
  await active;
  assert.deepEqual(scheduler.getStatus(), { state: 'running',
    activeStage: 'publish', lastStage: null, lastResult: null,
    lastFinishedMs: null });
  release();
  await firing;
  assert.deepEqual(scheduler.getStatus(), { state: 'waiting',
    activeStage: null, lastStage: 'publish', lastResult: 'processed',
    lastFinishedMs: 1234 });
  await scheduler.stop();
  assert.equal(scheduler.getStatus().state, 'stopped');
});
