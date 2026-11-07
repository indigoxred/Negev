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
import { evaluateHandoffEvidence } from '../src/acquisition/handoff-evidence.mjs';

const authorizedSession = { get: async () => ({ state: 'authenticated',
  sessionId: 'synthetic_sid' }), invalidate: () => ({ state: 'invalidated' }) };
const qbBaseUrl = 'http://qb:8080/';

test('pipeline never invokes a download processor while qBittorrent authentication is held', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-pipeline-auth-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const requests = openRequestLedger(dbPath);
  requests.submit({ requesterId: 1, requestKey: 'auth-hold', nowMs: 1,
    intent: { state: 'ready', anidbId: 42, kind: 'movie',
      episodeIds: [1001], monitorFuture: false } });
  const acquisitions = openAcquisitionLedger(dbPath);
  const handoffs = openHandoffLedger(dbPath);
  let invoked = 0;
  const pipeline = openAcquisitionPipeline({ dbPath, acquisitions,
    qbBaseUrl, sessionGate: { get: async () => ({ state: 'held',
      reason: 'authentication_backoff' }), invalidate: () => {} },
    processRequest: async () => { invoked++; return { state: 'held', reason: 'unsafe' }; },
    processStart: async () => { invoked++; },
    processCompletion: async () => { invoked++; },
    processPublish: async () => ({ state: 'held', reason: 'not_prepared' }),
    now: () => 100 });
  try {
    await pipeline.initialize();
    const result = await pipeline.tickRequests();
    assert.equal(result.results[0].reason, 'authentication_backoff');
    assert.equal(invoked, 0);
  } finally {
    await pipeline.close();
    handoffs.close(); acquisitions.close(); requests.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('private Shoko link stage is opt-in and reconciles before its first tick', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-pipeline-links-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const requests = openRequestLedger(dbPath);
  const acquisitions = openAcquisitionLedger(dbPath);
  const handoffs = openHandoffLedger(dbPath);
  const pipeline = openAcquisitionPipeline({ dbPath, acquisitions,
    qbBaseUrl, sessionGate: authorizedSession,
    processRequest: async () => ({ state: 'held', reason: 'not_expected' }),
    processStart: async () => ({ state: 'held', reason: 'not_expected' }),
    processCompletion: async () => ({ state: 'held', reason: 'not_expected' }),
    processPublish: async () => ({ state: 'held', reason: 'not_expected' }),
    processLink: async () => ({ state: 'held', reason: 'not_expected' }),
    now: () => 1_000 });
  try {
    assert.deepEqual(await pipeline.tickLinks(),
      { state: 'held', reason: 'reconciliation_required' });
    const recovery = await pipeline.initialize();
    assert.deepEqual(recovery.links.held, []);
    assert.deepEqual(await pipeline.tickLinks(), { state: 'idle' });
  } finally {
    await pipeline.close();
    handoffs.close(); acquisitions.close(); requests.close();
    await rm(dir, { recursive: true, force: true });
  }
});

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
      qbBaseUrl, sessionGate: authorizedSession,
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

test('unverified interrupted request holds its claim while a later request advances', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-pipeline-unverified-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const requests = openRequestLedger(dbPath);
  requests.submit({ requesterId: 1, requestKey: 'unverified', nowMs: 1,
    intent: { state: 'ready', anidbId: 42, kind: 'movie',
      episodeIds: [1001], monitorFuture: false } });
  requests.submit({ requesterId: 1, requestKey: 'independent', nowMs: 2,
    intent: { state: 'ready', anidbId: 43, kind: 'movie',
      episodeIds: [1002], monitorFuture: false } });
  const acquisitions = openAcquisitionLedger(dbPath);
  const handoffs = openHandoffLedger(dbPath);
  const oldQueue = openAcquisitionRequestQueue(dbPath);
  oldQueue.claimNext({ nowMs: 100 });
  oldQueue.close();
  const inspectRequest = acquisitions.inspectRequestAttempts.bind(acquisitions);
  let available = false;
  const processed = [];
  acquisitions.inspectRequestAttempts = (...args) => {
    if (!available) throw new Error('ledger unavailable');
    return inspectRequest(...args);
  };
  const pipeline = openAcquisitionPipeline({ dbPath, acquisitions,
    qbBaseUrl, sessionGate: authorizedSession,
    processRequest: async ({ requestId }) => { processed.push(requestId);
      return { state: 'held', reason: 'not_ready' }; },
    processStart: async () => { throw new Error('must not start'); },
    processCompletion: async () => { throw new Error('must not complete'); },
    processPublish: async () => { throw new Error('must not publish'); },
    now: () => 200 });
  try {
    const first = await pipeline.initialize();
    assert.equal(first.state, 'reconciled');
    assert.deepEqual(first.requests.held, [1]);
    assert.deepEqual((await pipeline.tickRequests()).results.map((item) => item.requestId), [2]);
    assert.deepEqual(processed, [2]);
    available = true;
    const recovered = await pipeline.initialize();
    assert.equal(recovered.state, 'reconciled');
    assert.deepEqual(recovered.requests.resolved, [1]);
    assert.equal((await pipeline.tickRequests()).state, 'pass_complete');
  } finally {
    await pipeline.close();
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
    qbBaseUrl, sessionGate: authorizedSession,
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
    assert.deepEqual(await pipeline.tickCompletions(),
      { state: 'held', reason: 'pipeline_busy' });
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

test('a held request does not block a later synthetic request-to-publish chain', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-pipeline-chain-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const requests = openRequestLedger(dbPath);
  for (let id = 1; id <= 2; id++) requests.submit({ requesterId: 1,
    requestKey: `chain-${id}`, nowMs: id,
    intent: { state: 'ready', anidbId: 40 + id, kind: 'series',
      episodeIds: [1000 + id], monitorFuture: false } });
  const acquisitions = openAcquisitionLedger(dbPath);
  const handoffs = openHandoffLedger(dbPath);
  const candidate = { indexerId: 7, guid: 'synthetic-second' };
  const hash = 'a'.repeat(40);
  const events = [];
  let attemptId;
  let pipeline;
  try {
    pipeline = openAcquisitionPipeline({ dbPath, acquisitions,
      qbBaseUrl, sessionGate: authorizedSession,
      processRequest: async ({ requestId }) => {
        events.push(`request:${requestId}`);
        if (requestId === 1) return { state: 'held',
          reason: 'target_not_proven_missing' };
        attemptId = acquisitions.reserve({ requestId, candidate,
          episodeIds: [1002], nowMs: 200 }).attemptId;
        acquisitions.bindPreparedTorrent({ attemptId, candidate, hash,
          nowMs: 201 });
        acquisitions.recordFilePlan({ attemptId, hash,
          plannedFiles: [{ name: '02.mkv', size: 10,
            episodeIds: [1002] }], nowMs: 202 });
        acquisitions.beginDispatch({ attemptId, nowMs: 203 });
        acquisitions.recordTorrent({ attemptId, hash, nowMs: 204 });
        return { state: 'stopped_observed', attemptId };
      },
      processStart: async ({ attemptId: selected }) => {
        events.push(`start:${selected}`);
        assert.equal(acquisitions.beginStart({ attemptId: selected, hash,
          manifestDigest: 'b'.repeat(64), nowMs: 205 }).state,
        'start_unknown');
        return { state: 'start_unknown' };
      },
      processCompletion: async ({ attemptId: selected }) => {
        events.push(`completion:${selected}`);
        const manifest = { anidbId: 42, torrentHash: hash,
          files: [{ name: '02.mkv', size: 10, ed2k: 'C'.repeat(32),
            anidbFileId: 51, episodeIds: [1002] }], subtitles: [] };
        const prepared = { ...manifest, state: 'handoff_prepared',
          publishReady: false, holdingPath: path.join(dir, 'holding'),
          evidenceDigest: evaluateHandoffEvidence(manifest).digest };
        assert.equal(handoffs.recordPrepared({ attemptId: selected,
          prepared, nowMs: 206 }).state, 'prepared');
        return { state: 'handoff_prepared' };
      },
      processPublish: async ({ attemptId: selected }) => {
        events.push(`publish:${selected}`);
        const row = handoffs.getHandoff(selected);
        const intent = handoffs.beginPublish({ attemptId: selected,
          evidenceDigest: row.evidenceDigest, nowMs: 207 });
        assert.equal(intent.state, 'publish_unknown');
        assert.equal(handoffs.markPublishedObserved({ attemptId: selected,
          evidenceDigest: row.evidenceDigest,
          publishName: intent.publishName, nowMs: 208 }).state,
        'published_observed');
        return { state: 'published_observed' };
      }, now: () => 5_000 });
    assert.equal((await pipeline.tickRequests()).reason, 'reconciliation_required');
    await pipeline.initialize();
    const checked = await pipeline.tickRequests();
    assert.deepEqual(checked.results.map((entry) => entry.state),
      ['held', 'stopped_observed']);
    assert.equal((await pipeline.tickStarts()).result.state, 'start_unknown');
    assert.equal((await pipeline.tickCompletions()).result.state,
      'handoff_prepared');
    assert.equal((await pipeline.tickPublish()).result.state, 'published_observed');
    assert.deepEqual(events, ['request:1', 'request:2',
      `start:${attemptId}`, `completion:${attemptId}`, `publish:${attemptId}`]);
    assert.equal(handoffs.getHandoff(attemptId).status, 'published_observed');
    assert.equal((await pipeline.tickStarts()).state, 'idle');
    await pipeline.close();
    pipeline = openAcquisitionPipeline({ dbPath, acquisitions,
      qbBaseUrl, sessionGate: authorizedSession,
      processRequest: async () => { throw new Error('No request replay'); },
      processStart: async () => { throw new Error('No start replay'); },
      processCompletion: async () => { throw new Error('No completion replay'); },
      processPublish: async () => { throw new Error('No publish replay'); },
      now: () => 5_001 });
    await pipeline.initialize();
    assert.equal((await pipeline.tickStarts()).state, 'idle');
    assert.equal((await pipeline.tickPublish()).state, 'idle');
    assert.equal((await pipeline.tickCompletions()).state, 'pass_complete');
    assert.equal((await pipeline.tickRequests()).state, 'pass_complete');
  } finally {
    if (pipeline) await pipeline.close();
    handoffs.close(); acquisitions.close(); requests.close();
    await rm(dir, { recursive: true, force: true });
  }
});
