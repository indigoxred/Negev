import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAcquisitionStageProcessors } from
  '../src/acquisition/acquisition-stage-processors.mjs';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { openAcquisitionLedger } from '../src/acquisition/acquisition-ledger.mjs';
import { openHandoffLedger } from '../src/acquisition/handoff-ledger.mjs';
import { openAcquisitionPipeline } from '../src/acquisition/acquisition-pipeline.mjs';
import { openAcquisitionRuntime } from '../src/acquisition/acquisition-runtime.mjs';

const request = { id: 1, status: 'held', anidbId: 42,
  kind: 'movie', episodeIds: [1001] };
const options = (calls) => ({
  requests: { getRequest: (id) => { calls.push(`request:${id}`); return request; } },
  acquisitions: { getAttempt: () => null },
  handoffs: { getHandoff: () => null },
  discoverCandidates: async ({ requestId }) => {
    calls.push('search');
    return { state: 'candidates', requestId, anidbId: 42, items: [] };
  },
  previewCandidate: async () => { throw Error('no candidate'); },
  loadDetail: async () => { throw Error('no detail'); },
  releaseQueries: async () => [],
  readEvidence: async () => { throw Error('no availability read'); },
  publicSections: { episode: [102], movie: [123] },
  prowlarr: { baseUrl: 'http://prowlarr:9696/', apiKey: 'synthetic',
    indexerIds: [1] },
  stagingHostPath: '/srv/negev/staging',
  holdingRoot: '/srv/negev/holding', importRoot: '/srv/shoko/import',
  inspectMounts: async () => { throw Error('no mount read'); },
  realpathImpl: async () => { throw Error('no realpath'); },
  shoko: { baseUrl: 'http://shoko:8111/', apiKey: 'synthetic',
    providerId: '11111111-2222-4333-8444-555555555555' },
  now: () => 200,
} );

test('construction is inert and a no-candidate request cannot touch download providers', async () => {
  const calls = [];
  const stages = createAcquisitionStageProcessors(options(calls));
  assert.deepEqual(calls, []);
  const result = await stages.processRequest({ requestId: 1,
    qbittorrent: { baseUrl: 'http://qb:8080/', sessionId: 'synthetic' },
    fetchImpl: async () => { throw Error('no qBittorrent call'); },
    providerFetchImpl: async () => { throw Error('no Prowlarr call'); } });
  assert.deepEqual(result, { state: 'held', reason: 'no_release_candidates',
    nextCandidateOffset: 0 });
  assert.deepEqual(calls, ['request:1', 'search']);
  assert.deepEqual(await stages.processStart({ attemptId: 999,
    qbittorrent: { baseUrl: 'http://qb:8080/', sessionId: 'synthetic' },
    fetchImpl: async () => { throw Error('no qBittorrent call'); } }),
  { state: 'held', reason: 'attempt_missing' });
});

test('missing safety providers are rejected before any work', () => {
  const calls = [];
  assert.throws(() => createAcquisitionStageProcessors({ ...options(calls),
    readEvidence: undefined }), TypeError);
  assert.deepEqual(calls, []);
});

test('disabled acquisition runtime never opens journals or reads provider configuration', async () => {
  let reads = 0;
  const input = { enabled: false,
    get dbPath() { reads++; throw Error('no database'); },
    get sessionGate() { reads++; throw Error('no qBittorrent login'); },
    get readEvidence() { reads++; throw Error('no media read'); } };
  const runtime = openAcquisitionRuntime(input);
  assert.equal(reads, 0);
  assert.deepEqual(await runtime.start(),
    { state: 'held', reason: 'runtime_disabled' });
  await runtime.stop();
  assert.equal(reads, 0);
});

test('real journals and stages hold a no-candidate request across restart without provider writes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-stage-'));
  const dbPath = path.join(root, 'state.sqlite');
  const requests = openRequestLedger(dbPath);
  requests.submit({ requesterId: 1, requestKey: 'film', nowMs: 1,
    intent: { state: 'ready', anidbId: 42, kind: 'movie',
      episodeIds: [1001], monitorFuture: false } });
  const acquisitions = openAcquisitionLedger(dbPath);
  const handoffs = openHandoffLedger(dbPath);
  const calls = [];
  const gate = { get: async () => ({ state: 'authenticated',
    sessionId: 'synthetic' }), invalidate: () => {} };
  const processors = createAcquisitionStageProcessors({ ...options(calls),
    requests, acquisitions, handoffs });
  const open = () => openAcquisitionPipeline({ dbPath, acquisitions,
    qbBaseUrl: 'http://qb:8080/', sessionGate: gate, ...processors,
    fetchImpl: async () => { throw Error('no network'); }, now: () => 200 });
  let pipeline;
  try {
    pipeline = open();
    assert.deepEqual(calls, []);
    assert.deepEqual(await pipeline.tickRequests(),
      { state: 'held', reason: 'reconciliation_required' });
    await pipeline.initialize();
    const first = await pipeline.tickRequests();
    assert.deepEqual(first.results, [{ requestId: 1, state: 'held',
      reason: 'no_release_candidates' }]);
    assert.deepEqual(calls, ['search']);
    await pipeline.close();
    pipeline = open();
    await pipeline.initialize();
    assert.deepEqual((await pipeline.tickRequests()).results, []);
    assert.deepEqual(calls, ['search']);
    assert.equal(acquisitions.getAttempt(1), null);
  } finally {
    await pipeline?.close();
    handoffs.close(); acquisitions.close(); requests.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('enabled source runtime reconciles before scheduling and closes without provider reads', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-runtime-'));
  const dbPath = path.join(root, 'state.sqlite');
  const requests = openRequestLedger(dbPath);
  const acquisitions = openAcquisitionLedger(dbPath);
  const handoffs = openHandoffLedger(dbPath);
  const calls = [];
  let runtime;
  try {
    runtime = openAcquisitionRuntime({ ...options(calls), enabled: true,
      dbPath, requests, acquisitions, handoffs,
      qbBaseUrl: 'http://qb:8080/',
      sessionGate: { get: async () => { throw Error('no login'); },
        invalidate: () => {} },
      fetchImpl: async () => { throw Error('no network'); } });
    assert.equal(runtime.getStatus().state, 'not_started');
    const recovery = await runtime.start();
    assert.equal(recovery.state, 'reconciled');
    assert.equal(runtime.getStatus().state, 'waiting');
    assert.deepEqual(calls, []);
  } finally {
    await runtime?.stop();
    handoffs.close(); acquisitions.close(); requests.close();
    await rm(root, { recursive: true, force: true });
  }
  assert.equal(runtime.getStatus().state, 'stopped');
});
