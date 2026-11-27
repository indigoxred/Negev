import assert from 'node:assert/strict';
import test from 'node:test';
import { createPipelineScheduler } from '../src/acquisition/acquisition-pipeline-scheduler.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(overrides = {}) {
  const jobs = new Map(), calls = [];
  let id = 0, now = 0, maximumPending = 0;
  const clock = {
    setTimer(fn, delay) { jobs.set(++id, { fn, due: now + delay }); maximumPending = Math.max(maximumPending, jobs.size); return id; },
    clearTimer(id) { jobs.delete(id); },
  };
  const pipeline = { initialize: async () => ({ state: 'reconciled' }),
    ...Object.fromEntries(['Completions', 'Publish', 'Starts', 'Requests'].map(name =>
      [`tick${name}`, async (options) => { calls.push(options?.priorityRequestId ?? name); return { state: 'idle' }; }])),
    close: async () => {}, ...overrides };
  const scheduler = createPipelineScheduler({ pipeline, now: () => now, ...clock });
  return { scheduler, calls, jobs, get maximumPending() { return maximumPending; },
    async fire() { const [key, job] = jobs.entries().next().value; jobs.delete(key); now = job.due; return job.fn(); },
    due: () => [...jobs.values()][0]?.due, get now() { return now; } };
}

test('wakes retain the newest 32 de-duplicated requests without starving regular stages', async () => {
  const f = fixture(); await f.scheduler.start();
  for (let id = 1; id <= 33; id++) f.scheduler.wakeRequest(id);
  f.scheduler.wakeRequest(20);
  assert.equal(f.due(), 1_000);
  for (let i = 0; i < 100; i++) await f.fire();
  const priority = f.calls.filter(Number.isInteger);
  assert.deepEqual(priority.slice(0, 3), [20, 33, 32]);
  assert.equal(priority.length, 32);
  assert.equal(new Set(priority).size, 32);
  assert.equal(priority.includes(1), false);
  assert.equal(f.calls[1], 'Completions');
  assert.equal(f.maximumPending, 1);
  await f.scheduler.stop(); assert.equal(f.jobs.size, 0);
});

test('wake during reconciliation is queued but does not replace its recovery wait', async () => {
  let attempts = 0;
  const f = fixture({ initialize: async () => ++attempts === 1
    ? { state: 'held' } : { state: 'reconciled' } });
  await f.scheduler.start(); const recoveryDue = f.due();
  f.scheduler.wakeRequest(8);
  assert.equal(f.due(), recoveryDue);
  assert.deepEqual(f.calls, []);
  await f.fire(); assert.equal(f.due(), f.now + 1_000);
  await f.fire(); assert.equal(f.calls[0], 8);
  assert.equal(f.maximumPending, 1);
  await f.scheduler.stop();
});

test('a running search allows media turns, retains wakes, and only advances a pending deadline', async () => {
  const search = deferred(), ids = [];
  const f = fixture({ tickRequests: async ({ priorityRequestId } = {}) => {
    ids.push(priorityRequestId); return ids.length === 1 ? search.promise : { state: 'idle' };
  } });
  await f.scheduler.start(); f.scheduler.wakeRequest(1); await f.fire();
  f.scheduler.wakeRequest(2);
  await f.fire(); await f.fire();
  assert.deepEqual(ids, [1]);
  assert.deepEqual(f.calls, ['Completions', 'Publish']);
  const oldDue = f.due();
  search.resolve({ state: 'page', results: [{ requestId: 1, nextDueMs: f.now + 100_000 }] });
  await new Promise(r => setImmediate(r));
  assert.ok(f.due() <= oldDue, 'a late search result cannot postpone the next tick');
  await f.fire();
  assert.deepEqual(ids, [1, 2]);
  assert.equal(f.maximumPending, 1);
  await f.scheduler.stop();
});

test('shutdown stops admission immediately and closes only after a pending search drains', async () => {
  const search = deferred(), order = [];
  const f = fixture({ beginShutdown: () => order.push('stop-admission'),
    tickRequests: async () => { order.push('search'); await search.promise; order.push('search-finished'); return { state: 'page' }; },
    close: async () => order.push('close') });
  await f.scheduler.start(); f.scheduler.wakeRequest(1); await f.fire();
  const stopping = f.scheduler.stop();
  assert.deepEqual(order, ['search', 'stop-admission']);
  assert.equal(f.jobs.size, 0);
  f.scheduler.wakeRequest(2); search.resolve();
  await stopping; await f.scheduler.stop();
  assert.deepEqual(order, ['search', 'stop-admission', 'search-finished', 'close']);
  assert.equal(f.jobs.size, 0);
});
