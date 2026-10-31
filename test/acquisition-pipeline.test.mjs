import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { openAcquisitionLedger } from '../src/acquisition/acquisition-ledger.mjs';
import { openHandoffLedger } from '../src/acquisition/handoff-ledger.mjs';
import { openAcquisitionRequestQueue } from
  '../src/acquisition/acquisition-request-queue.mjs';
import { openAcquisitionPipeline } from '../src/acquisition/acquisition-pipeline.mjs';

test('restart reconciliation precedes worker ticks and later requests advance', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-pipeline-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const requests = openRequestLedger(dbPath);
  for (let id = 1; id <= 3; id++) requests.submit({ requesterId: 1,
    requestKey: `request-${id}`, nowMs: id,
    intent: { state: 'ready', anidbId: 40 + id, kind: 'series',
      episodeIds: [1000 + id], monitorFuture: false } });
  const acquisitions = openAcquisitionLedger(dbPath);
  const handoffs = openHandoffLedger(dbPath);
  const oldQueue = openAcquisitionRequestQueue(dbPath);
  assert.equal(oldQueue.claimNext({ nowMs: 100 }).requestId, 1);
  oldQueue.close();
  const visited = [];
  let pipeline;
  try {
    pipeline = openAcquisitionPipeline({ dbPath, acquisitions,
      processRequest: async ({ requestId }) => {
        visited.push(requestId);
        return { state: 'held', reason: 'target_not_proven_missing' };
      },
      processStart: async () => { throw new Error('No start expected'); },
      processCompletion: async () => { throw new Error('No completion expected'); },
      processPublish: async () => { throw new Error('No publish expected'); },
      now: () => 200 });
    assert.deepEqual(await pipeline.tickRequests(),
      { state: 'held', reason: 'reconciliation_required' });
    const recovery = await pipeline.initialize();
    assert.deepEqual(recovery.requests.resolved, [1]);
    const page = await pipeline.tickRequests();
    assert.equal(page.state, 'pass_complete');
    assert.deepEqual(visited, [2, 3]);
    assert.deepEqual(page.results.map((entry) => entry.requestId), [2, 3]);
    assert.deepEqual(await pipeline.tickStarts(), { state: 'idle' });
    assert.deepEqual(await pipeline.tickPublish(), { state: 'idle' });
    await pipeline.close();
    assert.deepEqual(await pipeline.tickRequests(),
      { state: 'held', reason: 'pipeline_closed' });
  } finally {
    if (pipeline) await pipeline.close();
    handoffs.close(); acquisitions.close(); requests.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('closing the pipeline waits for an active request check before closing its journal', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-pipeline-drain-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const requests = openRequestLedger(dbPath);
  requests.submit({ requesterId: 1, requestKey: 'one', nowMs: 1,
    intent: { state: 'ready', anidbId: 42, kind: 'movie',
      episodeIds: [1001], monitorFuture: false } });
  const acquisitions = openAcquisitionLedger(dbPath);
  const handoffs = openHandoffLedger(dbPath);
  let release;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  const pipeline = openAcquisitionPipeline({ dbPath, acquisitions,
    processRequest: async () => { entered(); await blocked;
      return { state: 'held', reason: 'availability_unavailable' }; },
    processStart: async () => ({ state: 'held', reason: 'disabled' }),
    processCompletion: async () => ({ state: 'held', reason: 'disabled' }),
    processPublish: async () => ({ state: 'held', reason: 'disabled' }),
    now: () => 200 });
  try {
    await pipeline.initialize();
    const running = pipeline.tickRequests();
    await started;
    let drained = false;
    const closing = pipeline.close().then(() => { drained = true; });
    await Promise.resolve();
    assert.equal(drained, false);
    release();
    assert.equal((await running).state, 'pass_complete');
    await closing;
    assert.equal(drained, true);
  } finally {
    release(); await pipeline.close();
    handoffs.close(); acquisitions.close(); requests.close();
    await rm(dir, { recursive: true, force: true });
  }
});
