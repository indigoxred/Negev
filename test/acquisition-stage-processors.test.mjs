import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
import { ED2K_CHUNK_SIZE } from '../src/identity/ed2k.mjs';
import { evaluateHandoffEvidence } from '../src/acquisition/handoff-evidence.mjs';

const info = Buffer.from('d6:lengthi1000e4:name6:01.mkv12:piece lengthi16384e6:pieces20:aaaaaaaaaaaaaaaaaaaae');
const torrentBytes = Buffer.concat([Buffer.from('d4:info'), info, Buffer.from('e')]);
const torrentHash = createHash('sha1').update(info).digest('hex');

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
  readPublicCoverage: () => ({ verifiedTargets: 0, targetCount: 1 }),
  publicSections: { episode: [102], movie: [123] },
  prowlarr: { baseUrl: 'http://prowlarr:9696/', apiKey: 'synthetic',
    indexerIds: [1] },
  stagingHostPath: '/srv/negev/staging',
  holdingRoot: '/srv/negev/holding', importRoot: '/srv/shoko/import',
  inspectMounts: async () => { throw Error('no mount read'); },
  verifyStagingRoot: async () => ({ state: 'verified_staging_root' }),
  ensureImportRoot: async () => ({ state: 'import_child_ready' }),
  verifyShokoSource: async () => ({ state: 'verified_shoko_source' }),
  realpathImpl: async () => { throw Error('no realpath'); },
  shoko: { baseUrl: 'http://shoko:8111/', apiKey: 'synthetic',
    providerId: '11111111-2222-4333-8444-555555555555' },
  now: () => 200,
} );

test('Sonarr ownership blocks request search and a previously reserved start', async () => {
  const calls = [];
  const guard = { refresh: async () => ({ state: 'ready' }),
    status: () => 'owned' };
  const stages = createAcquisitionStageProcessors({ ...options(calls),
    ownershipGate: guard,
    acquisitions: { getAttempt: () => ({ id: 7, requestId: 1 }) },
  });
  assert.deepEqual(await stages.processRequest({ requestId: 1,
    qbittorrent: { baseUrl: 'http://qb:8080/', sessionId: 'synthetic' },
    fetchImpl: async () => { throw Error('qBittorrent called'); },
    providerFetchImpl: async () => { throw Error('Prowlarr called'); } }),
  { state: 'held', reason: 'sonarr_title_owned' });
  assert.deepEqual(await stages.processStart({ attemptId: 7,
    qbittorrent: { baseUrl: 'http://qb:8080/', sessionId: 'synthetic' },
    fetchImpl: async () => { throw Error('qBittorrent called'); } }),
  { state: 'held', reason: 'sonarr_title_owned' });
  assert.ok(!calls.includes('search'));
});

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

test('opt-in pure move mode routes recorded attempts without invoking legacy hashes', async () => {
  const calls = [];
  const stages = createAcquisitionStageProcessors({ ...options(calls),
    qbitStagingRoot: '/NegevPure',
    pureMode: true,
    verifyHandoffMounts: async () => ({ state: 'mounted_handoff_roots' }),
    pureMoves: { getIntent: () => ({ status: 'moving' }),
      recordIntent: () => ({ state: 'recorded' }),
      markPrepared: () => ({ state: 'prepared' }) },
    acquisitions: { getAttempt: () => ({ id: 7, requestId: 1 }),
      getStart: () => ({ torrentHash }), getFilePlan: () => [] },
  });
  assert.deepEqual(await stages.processCompletion({ attemptId: 7,
    qbittorrent: { baseUrl: 'http://qb:8080/', sessionId: 'synthetic' },
    fetchImpl: async () => { throw Error('qBittorrent must not be contacted'); } }),
  { state: 'held', reason: 'handoff_already_recorded' });
});

test('missing safety providers are rejected before any work', () => {
  const calls = [];
  assert.throws(() => createAcquisitionStageProcessors({ ...options(calls),
    readEvidence: undefined }), TypeError);
  assert.deepEqual(calls, []);
  assert.throws(() => createAcquisitionStageProcessors({ ...options(calls),
    readPublicCoverage: undefined }), TypeError);
});

test('recent exact public coverage avoids the indexer in the wired request stage', async () => {
  const calls = [];
  const stages = createAcquisitionStageProcessors({ ...options(calls),
    readPublicCoverage: () => ({ verifiedTargets: 1, targetCount: 1 }) });
  const result = await stages.processRequest({ requestId: 1,
    qbittorrent: { baseUrl: 'http://qb:8080/', sessionId: 'synthetic' },
    fetchImpl: async () => { throw Error('qBittorrent called'); },
    providerFetchImpl: async () => { throw Error('Prowlarr called'); } });
  assert.deepEqual(result, { state: 'held', reason: 'request_fully_available',
    nextCandidateOffset: 0 });
  assert.deepEqual(calls, ['request:1']);
});

test('the wired request stage skips a proven active claim before submission', async () => {
  const calls = [];
  const release = { indexerId: 1, guid: 'owned-elsewhere',
    title: 'Example - 01', evidence: 'unverified' };
  const stages = createAcquisitionStageProcessors({ ...options(calls),
    acquisitions: { getAttempt: () => null,
      inspectCandidateTargets: ({ requestId, candidate, episodeIds }) => {
        assert.equal(requestId, 1);
        assert.equal(candidate.guid, release.guid);
        assert.deepEqual(episodeIds, [1001]);
        calls.push('claim');
        return { state: 'skip_active' };
      } },
    discoverCandidates: async ({ requestId }) => ({ state: 'candidates',
      requestId, anidbId: 42, items: [release] }),
    previewCandidate: async ({ requestId }) => ({ state: 'preflight',
      requestId, anidbId: 42, torrentHash,
      episodeIds: [1001], files: [{ name: 'Example - 01.mkv',
        size: 1000, episodeIds: [1001] }] }),
  });
  const result = await stages.processRequest({ requestId: 1,
    qbittorrent: { baseUrl: 'http://qb:8080/', sessionId: 'synthetic' },
    fetchImpl: async () => { throw Error('qBittorrent called'); },
    providerFetchImpl: async () => { throw Error('Prowlarr called'); } });
  assert.equal(result.reason, 'no_safe_release');
  assert.deepEqual(calls, ['request:1', 'claim']);
});

test('completion and publish hold before media work when the own mount is unproved', async () => {
  const calls = [];
  const stages = createAcquisitionStageProcessors({ ...options(calls),
    ensureImportRoot: async () => {
      calls.push('ensure-child');
      return { state: 'import_child_ready' };
    },
    verifyHandoffMounts: async () => {
      calls.push('handoff-mount');
      return { state: 'held', reason: 'handoff_mount_unavailable' };
    } });
  assert.deepEqual(await stages.processCompletion({ attemptId: 1 }),
    { state: 'held', reason: 'handoff_mount_unavailable' });
  assert.deepEqual(await stages.processPublish({ attemptId: 1 }),
    { state: 'held', reason: 'handoff_mount_unavailable' });
  assert.deepEqual(calls, ['ensure-child', 'handoff-mount',
    'ensure-child', 'handoff-mount']);
});

test('completion holds when the staging mount changed after torrent start', async () => {
  const calls = [];
  const stages = createAcquisitionStageProcessors({ ...options(calls),
    verifyStagingRoot: async () => ({ state: 'held',
      reason: 'staging_root_unverified' }),
    verifyHandoffMounts: async () => {
      calls.push('handoff-mount');
      return { state: 'mounted_handoff_roots' };
    },
    acquisitions: { getAttempt: () => { throw Error('must not read attempt'); },
      getFilePlan: () => { throw Error('must not read file plan'); } },
  });
  assert.deepEqual(await stages.processCompletion({ attemptId: 1 }),
    { state: 'held', reason: 'staging_root_unverified' });
  assert.deepEqual(calls, []);
});

test('completion and publish hold if Shoko no longer watches the dedicated Source', async () => {
  const calls = [];
  const stages = createAcquisitionStageProcessors({ ...options(calls),
    verifyShokoSource: async () => ({ state: 'held',
      reason: 'shoko_source_unverified' }),
    ensureImportRoot: async () => { calls.push('child'); throw Error('must not write'); },
  });
  assert.deepEqual(await stages.processCompletion({ attemptId: 1 }),
    { state: 'held', reason: 'handoff_mount_unavailable' });
  assert.deepEqual(await stages.processPublish({ attemptId: 1 }),
    { state: 'held', reason: 'handoff_mount_unavailable' });
  assert.deepEqual(calls, []);
});

test('exact-boundary work holds on Shoko native preference', async () => {
  const calls = [];
  const stages = createAcquisitionStageProcessors({ ...options(calls),
    acquisitions: { getAttempt: () => null,
      getFilePlan: () => [{ name: '01.mkv', size: ED2K_CHUNK_SIZE }] },
    handoffs: { getHandoff: () => ({ manifest: {
      videos: [{ name: '01.mkv', size: ED2K_CHUNK_SIZE }] } }) },
    verifyHandoffMounts: async () => ({ state: 'mounted_handoff_roots' }),
    readEd2kMode: async () => { calls.push('hash-mode');
      return { state: 'mode', mode: 'emule',
        basis: 'configured_native_preference' }; } });
  assert.deepEqual(await stages.processCompletion({ attemptId: 1 }),
    { state: 'held', reason: 'ed2k_boundary_mode_unverified' });
  assert.deepEqual(await stages.processPublish({ attemptId: 1 }),
    { state: 'held', reason: 'ed2k_boundary_mode_unverified' });
  assert.deepEqual(calls, ['hash-mode', 'hash-mode']);
});

test('an already observed boundary handoff needs no fresh Shoko hash-mode read', async () => {
  const evidence = evaluateHandoffEvidence({ anidbId: 42,
    torrentHash: 'a'.repeat(40), files: [{ name: '01.mkv',
      size: ED2K_CHUNK_SIZE, ed2k: 'A'.repeat(32),
      anidbFileId: 51, episodeIds: [1001] }], subtitles: [] });
  const row = { status: 'published_observed',
    holdingPath: '/srv/negev/holding/.negev-prep-example',
    torrentHash: evidence.manifest.torrentHash,
    evidenceDigest: evidence.digest, manifest: evidence.manifest,
    publishName: `negev-1-${evidence.digest.slice(0, 16)}` };
  let modeReads = 0;
  const stages = createAcquisitionStageProcessors({ ...options([]),
    handoffs: { getHandoff: () => row, beginPublish: () => {
      throw Error('already published'); }, markPublishedObserved: () => {
      throw Error('already published'); } },
    verifyHandoffMounts: async () => ({ state: 'mounted_handoff_roots' }),
    readEd2kMode: async () => { modeReads++; return { state: 'unavailable' }; } });
  assert.deepEqual(await stages.processPublish({ attemptId: 1 }),
    { state: 'published_observed' });
  assert.equal(modeReads, 0);
});

test('an observed offline handoff resumes after Shoko moves its watched source', async () => {
  const evidence = evaluateHandoffEvidence({ anidbId: 42,
    torrentHash: 'b'.repeat(40), files: [{ name: '01.mkv', size: 1000,
      ed2k: 'A'.repeat(32), identitySource: 'shoko_offline',
      releaseId: 'offline://42-1001', episodeIds: [1001] }], subtitles: [] });
  const row = { status: 'published_observed',
    holdingPath: '/srv/negev/holding/.negev-prep-example',
    torrentHash: evidence.manifest.torrentHash,
    evidenceDigest: evidence.digest, manifest: evidence.manifest,
    publishName: `negev-1-${evidence.digest.slice(0, 16)}` };
  let mountChecks = 0;
  const stages = createAcquisitionStageProcessors({ ...options([]),
    handoffs: { getHandoff: () => row, beginPublish: () => {
      throw Error('already published'); }, markPublishedObserved: () => {
      throw Error('already published'); } },
    verifyHandoffMounts: async () => { mountChecks++;
      return { state: 'held', reason: 'handoff_mount_unavailable' }; },
    readEd2kMode: async () => { throw Error('no hash-mode read'); } });
  assert.deepEqual(await stages.processPublish({ attemptId: 1 }),
    { state: 'published_observed' });
  assert.equal(mountChecks, 0);
});

test('movie request stage uses both public Plex sections before stopped submission', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-movie-stage-'));
  const dbPath = path.join(root, 'state.sqlite');
  const requests = openRequestLedger(dbPath);
  const saved = requests.submit({ requesterId: 1, requestKey: 'movie', nowMs: 1,
    intent: { state: 'ready', anidbId: 42, kind: 'movie', title: 'Example',
      episodeIds: [1001], monitorFuture: false } });
  const acquisitions = openAcquisitionLedger(dbPath);
  const handoffs = openHandoffLedger(dbPath);
  let observedLibraries = [102];
  const qbCalls = [];
  const searchedQueries = [];
  const release = { indexerId: 3, guid: 'movie-release',
    title: 'Example 01', size: 1000, evidence: 'unverified' };
  const proxy = 'http://prowlarr:9696/3/download?apikey=synthetic&link=abc123&file=Example';
  const savePath = `/Downloads/negev/${torrentHash}`;
  const qbFetch = async (url, init) => {
    const endpoint = new URL(url).pathname;
    qbCalls.push(endpoint);
    if (endpoint === '/api/v2/app/version') return new Response('v5.3.0');
    if (endpoint.endsWith('/add')) return new Response('Ok.');
    if (endpoint.endsWith('/info') &&
        qbCalls.filter((call) => call.endsWith('/info')).length === 1) {
      return Response.json([]);
    }
    return Response.json(endpoint.endsWith('/files')
      ? [{ index: 0, name: '01.mkv', size: 1000, priority: 1, progress: 0 }]
      : endpoint.endsWith('/properties')
        ? { save_path: savePath, download_path: '' }
        : [{ hash: torrentHash, category: 'negev', save_path: savePath,
          state: 'stoppedDL', progress: 0, downloaded: 0, amount_left: 1000,
          auto_tmm: false, force_start: false }]);
  };
  const prowlarrFetch = async (url) => {
    if (new URL(url).pathname.endsWith('/search')) {
      searchedQueries.push(new URL(url).searchParams.get('query'));
      return Response.json([{ ...release, protocol: 'torrent', downloadUrl: proxy }]);
    }
    return new Response(torrentBytes,
      { headers: { 'content-type': 'application/x-bittorrent' } });
  };
  try {
    const processors = createAcquisitionStageProcessors({ ...options([]),
      requests, acquisitions, handoffs,
      prowlarr: { ...options([]).prowlarr, indexerIds: [3] },
      discoverCandidates: async ({ requestId }) => ({ state: 'candidates',
        requestId, anidbId: 42, items: [release] }),
      previewCandidate: async ({ requestId }) => ({ state: 'preflight',
        requestId, anidbId: 42, torrentHash, episodeIds: [1001],
        files: [{ name: '01.mkv', size: 1000, episodeIds: [1001] }] }),
      loadDetail: async () => ({ state: 'details', complete: true, total: 1,
        anidbId: 42, kind: 'movie', title: 'Example', restricted: false,
        episodes: [{ id: 1001, number: 1, type: 'Episode' }] }),
      readEvidence: async () => {
        return { anidbId: 42, episodeIds: [1001], observedAtMs: 199,
          importFence: { state: 'settled', anidbId: 42, episodeIds: [1001],
            beforeObservedAtMs: 198, afterObservedAtMs: 199 },
          shoko: { state: 'ok', complete: true, files: [] },
          plex: { state: 'ok', complete: true, sourceVerified: true,
            libraryIds: observedLibraries, parts: [] } };
      },
      readRelatedTitles: async () => ({ state: 'related_titles',
        anidbId: 42, items: [] }),
      inspectMounts: async () => ({ qbittorrent: [
        { Type: 'bind', Source: '/srv/negev/staging',
          Destination: '/Downloads/negev', RW: true }],
      shoko: [{ Type: 'bind', Source: '/srv/library', Destination: '/pure', RW: true }],
      plex: [{ Type: 'bind', Source: '/srv/library',
        Destination: '/source-pure', RW: false }] }),
      realpathImpl: async () => '/srv/negev/staging',
      now: () => 200 });
    const claim = { requestId: saved.requestId,
      qbittorrent: { baseUrl: 'http://qb:8080/', sessionId: 'synthetic' },
      fetchImpl: qbFetch, providerFetchImpl: prowlarrFetch };
    const incomplete = await processors.processRequest(claim);
    assert.equal(incomplete.state, 'held');
    assert.equal(incomplete.reason, 'target_not_proven_missing');
    assert.equal(qbCalls.length, 0);
    observedLibraries = [102, 123];
    const result = await processors.processRequest(claim);
    assert.equal(result.state, 'stopped_observed', JSON.stringify(result));
    assert.equal(qbCalls.filter((call) => call.endsWith('/add')).length, 1);
    assert.deepEqual(searchedQueries, ['Example', 'Example']);
    assert.deepEqual(acquisitions.getAttempt(result.attemptId).episodeIds, [1001]);
    observedLibraries = [102];
    const start = await processors.processStart({ attemptId: result.attemptId,
      qbittorrent: claim.qbittorrent, fetchImpl: qbFetch });
    assert.equal(start.state, 'held');
    assert.equal(start.reason, 'target_not_proven_missing');
    assert.equal(qbCalls.filter((call) => call.endsWith('/start')).length, 0);
    observedLibraries = [102, 123];
    const started = await processors.processStart({ attemptId: result.attemptId,
      qbittorrent: claim.qbittorrent, fetchImpl: qbFetch });
    assert.equal(started.state, 'start_unknown');
    assert.equal(started.sendNow, true);
    assert.equal(qbCalls.filter((call) => call.endsWith('/start')).length, 1);
    assert.equal((await processors.processStart({ attemptId: result.attemptId,
      qbittorrent: claim.qbittorrent, fetchImpl: qbFetch })).sendNow, false);
    assert.equal(qbCalls.filter((call) => call.endsWith('/start')).length, 1);
  } finally {
    handoffs.close(); acquisitions.close(); requests.close();
    await rm(root, { recursive: true, force: true });
  }
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
