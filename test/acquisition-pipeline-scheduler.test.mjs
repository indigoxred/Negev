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

test('held reconciliation retries without scheduling acquisition work', async () => {
  const timer = clock();
  let closed = false;
  let attempts = 0;
  const pipeline = {
    initialize: async () => ++attempts === 1
      ? { state: 'held', reason: 'reconciliation_unavailable' }
      : { state: 'reconciled' },
    tickPublish: async () => ({ state: 'idle' }),
    tickCompletions: async () => { throw new Error('must not tick'); },
    tickStarts: async () => { throw new Error('must not tick'); },
    tickRequests: async () => { throw new Error('must not tick'); },
    close: async () => { closed = true; },
  };
  const scheduler = createPipelineScheduler({ pipeline,
    setTimer: timer.setTimer, clearTimer: timer.clearTimer });
  assert.deepEqual(await scheduler.start(),
    { state: 'held', reason: 'reconciliation_unavailable' });
  assert.equal(scheduler.getStatus().state, 'reconciliation_held');
  assert.deepEqual(timer.delays(), [5 * 60_000]);
  await timer.advance();
  assert.equal(attempts, 2);
  assert.equal(scheduler.getStatus().state, 'waiting');
  assert.deepEqual(timer.delays(), [60_000]);
  await scheduler.stop();
  assert.equal(closed, true);
});

test('unresolved crash claim allows other stages and is rechecked without a restart', async () => {
  const timer = clock();
  let checks = 0;
  const stagesSeen = [];
  const reviewed = (held) => ({ state: 'reconciled',
    requests: { held }, starts: { held: [] },
    completions: { held: [] }, publishes: { held: [] } });
  const pipeline = {
    initialize: async () => ++checks === 1 ? reviewed([1]) : reviewed([]),
    tickPublish: async () => { stagesSeen.push('publish'); return { state: 'idle' }; },
    tickCompletions: async () => { stagesSeen.push('completion'); return { state: 'idle' }; },
    tickStarts: async () => { stagesSeen.push('start'); return { state: 'idle' }; },
    tickRequests: async () => { stagesSeen.push('request'); return { state: 'page' }; },
    close: async () => {},
  };
  const scheduler = createPipelineScheduler({ pipeline,
    setTimer: timer.setTimer, clearTimer: timer.clearTimer });
  assert.equal((await scheduler.start()).state, 'reconciled');
  assert.equal(scheduler.getStatus().state, 'waiting_with_review');
  for (let i = 0; i < 4; i++) await timer.advance();
  assert.deepEqual(stagesSeen, ['publish', 'completion', 'start', 'request']);
  assert.equal(checks, 2);
  assert.equal(scheduler.getStatus().state, 'waiting');
  await scheduler.stop();
});

test('failed reconciliation retries safely and shutdown cancels that retry', async () => {
  const timer = clock();
  let attempts = 0;
  let ticks = 0;
  const pipeline = {
    initialize: async () => { attempts++; throw new Error('database busy'); },
    tickPublish: async () => { ticks++; },
    tickCompletions: async () => { ticks++; },
    tickStarts: async () => { ticks++; },
    tickRequests: async () => { ticks++; },
    close: async () => {},
  };
  const scheduler = createPipelineScheduler({ pipeline,
    setTimer: timer.setTimer, clearTimer: timer.clearTimer });
  await assert.rejects(scheduler.start(), /database busy/);
  assert.equal(scheduler.getStatus().state, 'reconciliation_failed');
  assert.deepEqual(timer.delays(), [5 * 60_000]);
  await scheduler.stop();
  assert.deepEqual(timer.delays(), []);
  assert.equal(attempts, 1);
  assert.equal(ticks, 0);
});

test('a held target does not delay unrelated acquisition stages', async () => {
  const timer = clock();
  const calls = [];
  const pipeline = {
    initialize: async () => ({ state: 'reconciled' }),
    tickPublish: async () => { calls.push('publish');
      return { state: 'held', reason: 'import_activity_unverified' }; },
    tickCompletions: async () => { calls.push('completion');
      return { state: 'idle' }; },
    tickStarts: async () => ({ state: 'idle' }),
    tickRequests: async () => ({ state: 'idle' }),
    close: async () => {},
  };
  const scheduler = createPipelineScheduler({ pipeline,
    setTimer: timer.setTimer, clearTimer: timer.clearTimer });
  await scheduler.start();
  await timer.advance();
  assert.deepEqual(timer.delays(), [60_000]);
  await timer.advance();
  assert.deepEqual(calls, ['publish', 'completion']);
  await scheduler.stop();
});

test('a failed worker call uses the longer retry delay', async () => {
  const timer = clock();
  const pipeline = {
    initialize: async () => ({ state: 'reconciled' }),
    tickPublish: async () => { throw new Error('provider unavailable'); },
    tickCompletions: async () => ({ state: 'idle' }),
    tickStarts: async () => ({ state: 'idle' }),
    tickRequests: async () => ({ state: 'idle' }),
    close: async () => {},
  };
  const scheduler = createPipelineScheduler({ pipeline,
    setTimer: timer.setTimer, clearTimer: timer.clearTimer });
  await scheduler.start();
  await timer.advance();
  assert.deepEqual(timer.delays(), [5 * 60_000]);
  await scheduler.stop();
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
