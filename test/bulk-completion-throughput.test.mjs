import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { openAcquisitionLedger } from '../src/acquisition/acquisition-ledger.mjs';
import { openPureMoveLedger } from '../src/acquisition/pure-move-ledger.mjs';
import { openAcquisitionPipeline } from '../src/acquisition/acquisition-pipeline.mjs';
import { createPipelineScheduler } from '../src/acquisition/acquisition-pipeline-scheduler.mjs';
import { processPureCompletedAttempt } from '../src/acquisition/process-pure-completed-attempt.mjs';
import { publishPureMove } from '../src/acquisition/publish-pure-move.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-bulk-completion-'));
  const dbPath = path.join(root, 'db.sqlite');
  const requests = openRequestLedger(dbPath), acquisitions = openAcquisitionLedger(dbPath);
  const ids = Array.from({ length: 20 }, (_, i) => 1001 + i);
  const requestId = requests.submit({ requesterId: 1, requestKey: 'desired', nowMs: 1,
    intent: { state: 'ready', title: 'Example', anidbId: 42, kind: 'series',
      monitorFuture: false, episodeIds: ids } }).requestId;
  const attempts = [];
  for (let i = 0; i < 20; i++) {
    const candidate = { indexerId: 1, guid: 'release-' + i };
    const hash = (i + 1).toString(16).padStart(40, '0');
    const name = 'Example - ' + (i + 1) + '.mkv';
    const attemptId = acquisitions.reserve({ requestId, candidate,
      episodeIds: [ids[i]], nowMs: 10 }).attemptId;
    acquisitions.bindPreparedTorrent({ attemptId, candidate, hash, nowMs: 11 });
    acquisitions.recordFilePlan({ attemptId, hash, plannedFiles: [
      { name, size: 3, episodeIds: [ids[i]] }], nowMs: 12 });
    acquisitions.beginDispatch({ attemptId, nowMs: 13 });
    acquisitions.recordTorrent({ attemptId, hash, nowMs: 14 });
    acquisitions.beginStart({ attemptId, hash, manifestDigest: 'b'.repeat(64), nowMs: 15 });
    attempts.push({ attemptId, hash, name });
  }
  const moves = openPureMoveLedger(dbPath);
  let clock = 1000, sequence = 0, scheduler, pipeline;
  const timers = new Map();
  t.after(async () => {
    await scheduler?.stop(); await pipeline?.close();
    moves.close(); acquisitions.close(); requests.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, requests, acquisitions, moves, attempts,
    get now() { return clock; }, advance(ms) { clock += ms; },
    build(processCompletion, processPublish = async () => ({ state: 'idle' })) {
      pipeline = openAcquisitionPipeline({ dbPath, acquisitions, pureMode: true,
        qbBaseUrl: 'http://synthetic.invalid/', sessionGate: {
          get: async () => ({ state: 'authenticated', sessionId: 'testSID' }), invalidate() {} },
        now: () => clock, shokoRescans: { listDue: () => [], isEnrolled: () => false,
          getAttemptStatus: () => null, endAttempt() {} },
        processRescan: async () => ({ state: 'idle' }), processCompletion, processPublish,
        processStart: async () => ({ state: 'idle' }),
        processRequest: async () => ({ state: 'held', reason: 'no_safe_release' }) });
      return pipeline;
    },
    async start() {
      scheduler = createPipelineScheduler({ pipeline, now: () => clock,
        setTimer: (fn, ms) => { const id = ++sequence; timers.set(id, { fn, ms }); return id; },
        clearTimer: id => timers.delete(id) });
      await scheduler.start();
    },
    stop() { return scheduler.stop(); },
    async tick() {
      const [id, timer] = timers.entries().next().value;
      timers.delete(id); clock += timer.ms; await timer.fn(); await new Promise(setImmediate);
    },
  };
}

test('twenty started torrents receive their first completion check within ninety seconds', async t => {
  const f = await fixture(t), observed = [];
  f.build(async ({ attemptId }) => {
    observed.push({ attemptId, elapsedMs: f.now - 1000 });
    return { state: 'held', reason: 'incomplete' };
  });
  await f.start();
  for (let n = 0; n < 15 && observed.length < 20; n++) await f.tick();
  assert.equal(observed.length, 20);
  assert.equal(new Set(observed.map(row => row.attemptId)).size, 20);
  assert.equal(observed[19].elapsedMs, 90_000);
  console.log(JSON.stringify({ firstMs: observed[0].elapsedMs,
    twentiethMs: observed[19].elapsedMs, queue: 'production', scheduler: 'production' }));
});

test('twenty finished downloads prepare and publish through actual moves without a publication bottleneck', async t => {
  const f = await fixture(t), published = [];
  const stagingHostPath = path.join(f.root, 'stage'), holdingRoot = path.join(f.root, 'holding');
  const importRoot = path.join(f.root, 'import');
  await Promise.all([holdingRoot, importRoot].map(dir => mkdir(dir, { recursive: true })));
  for (const row of f.attempts) {
    await mkdir(path.join(stagingHostPath, row.hash), { recursive: true });
    await writeFile(path.join(stagingHostPath, row.hash, row.name), 'abc');
  }
  f.build(async input => {
    const row = f.attempts.find(row => row.attemptId === input.attemptId);
    return processPureCompletedAttempt({ ...input, requests: f.requests, acquisitions: f.acquisitions,
      pureMoves: f.moves, nowMs: f.now, stagingHostPath, qbitStagingRoot: '/Downloads/negev',
      holdingRoot, importRoot, verifyStagingRoot: async () => ({ state: 'verified_staging_root' }),
      verifyHandoffMounts: async () => ({ state: 'mounted_handoff_roots' }),
      stop: async () => ({ state: 'complete', files: [{ name: row.name, size: 3 }], subtitles: [] }) });
  }, async ({ attemptId }) => {
    const result = await publishPureMove({ attemptId, ledger: f.moves, holdingRoot,
      importRoot, nowMs: f.now });
    if (result.state === 'published_observed') published.push(attemptId);
    return result;
  });
  await f.start();
  for (let n = 0; n < 15 && published.length < 20; n++) await f.tick();
  assert.equal(published.length, 20);
  assert.equal(new Set(published).size, 20);
  assert.equal(f.now - 1000, 105_000);
  for (const row of f.attempts) {
    const intent = f.moves.getIntent(row.attemptId);
    assert.equal(intent.status, 'published_observed');
    assert.equal(await readFile(path.join(importRoot, path.basename(intent.manifest.holdingPath), row.name), 'utf8'), 'abc');
  }
});

test('a slow completion gives other stages their turn after the in-flight record', async t => {
  const f = await fixture(t); let calls = 0;
  const pipeline = f.build(async () => { calls++; f.advance(6000);
    return { state: 'held', reason: 'incomplete' }; });
  await pipeline.initialize(); await pipeline.tickCompletions();
  assert.equal(calls, 1); assert.equal((await pipeline.tickPublish()).state, 'idle');
});

test('a shared provider outage does not generate a burst across the backlog', async t => {
  const f = await fixture(t); let calls = 0;
  const pipeline = f.build(async () => { calls++;
    return { state: 'held', reason: 'provider_http_error' }; });
  await pipeline.initialize(); await pipeline.tickCompletions();
  assert.equal(calls, 1);
});

test('concurrent completion ticks cannot duplicate claims and shutdown stops the next claim', async t => {
  const f = await fixture(t); let release, entered; let calls = 0;
  const ready = new Promise(resolve => { entered = resolve; });
  const pipeline = f.build(async () => { calls++; entered(); await new Promise(resolve => { release = resolve; });
    return { state: 'held', reason: 'incomplete' }; });
  await pipeline.initialize(); const running = pipeline.tickCompletions(); await ready;
  assert.deepEqual(await pipeline.tickCompletions(), { state: 'held', reason: 'pipeline_busy' });
  const stopped = pipeline.close(); release(); await running; await stopped;
  assert.equal(calls, 1);
});


test('production scheduler shutdown prevents the next batch claim while draining the current record', async t => {
  const f = await fixture(t); let release, entered, calls = 0;
  const ready = new Promise(resolve => { entered = resolve; });
  f.build(async () => { calls++; entered(); await new Promise(resolve => { release = resolve; });
    return { state: 'held', reason: 'incomplete' }; });
  await f.start(); const ticking = f.tick(); await ready;
  const stopping = f.stop(); release();
  // A second claim would wait on a second gate and hang shutdown. Fail promptly.
  await Promise.race([Promise.all([ticking, stopping]), new Promise((_, reject) => {
    const timeout = setTimeout(() => reject(Error('shutdown claimed another record')), 2000); timeout.unref();
  })]);
  assert.equal(calls, 1);
});

test('a failing stop endpoint yields rather than bursting across the completed backlog', async t => {
  const f = await fixture(t); let calls = 0;
  const pipeline = f.build(async () => { calls++;
    return { state: 'held', reason: 'stop_outcome_unknown' }; });
  await pipeline.initialize(); await pipeline.tickCompletions();
  assert.equal(calls, 1);
});
