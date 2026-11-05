import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { openAcquisitionLedger } from '../src/acquisition/acquisition-ledger.mjs';
import { submitMissingCandidate } from '../src/acquisition/submit-missing-candidate.mjs';
import { createAcquisitionRequestProcessor } from
  '../src/acquisition/acquisition-request-processor.mjs';
import { openAcquisitionRequestQueue, createAcquisitionPageWorker } from
  '../src/acquisition/acquisition-request-queue.mjs';

const info = Buffer.from('d6:lengthi1000e4:name6:01.mkv12:piece lengthi16384e6:pieces20:aaaaaaaaaaaaaaaaaaaae');
const bytes = Buffer.concat([Buffer.from('d4:info'), info, Buffer.from('e')]);
const hash = createHash('sha1').update(info).digest('hex');
const savePath = `/Downloads/negev/${hash}`;
const candidate = { indexerId: 3, guid: 'release-1', title: 'Example 01', size: 1000 };
const proxy = 'http://prowlarr.internal:9696/3/download?apikey=syntheticKey&link=abc123&file=Example';
const hostPath = '/srv/negev/staging';
const mount = (Source, Destination, RW = true) => ({ Type: 'bind', Source, Destination, RW });
const mounts = { qbittorrent: [mount(hostPath, '/Downloads/negev')],
  shoko: [mount('/srv/library', '/pure')],
  plex: [mount('/srv/library', '/source-pure', false)] };
const torrent = { hash, category: 'negev', save_path: savePath,
  state: 'stoppedDL', progress: 0, downloaded: 0, amount_left: 1000,
  auto_tmm: false, force_start: false };
const files = [{ index: 0, name: '01.mkv', size: 1000, priority: 1, progress: 0 }];
const baseDetail = { state: 'details', complete: true, total: 2,
  anidbId: 42, kind: 'series', title: 'Example', restricted: false,
  episodes: [{ id: 1001, number: 1, type: 'Episode' },
    { id: 1002, number: 2, type: 'Episode' }] };

async function withLedgers(run, intent = { state: 'ready', anidbId: 42,
  kind: 'series', monitorFuture: false, episodeIds: [1001, 1002] }) {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-coordinate-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const requests = openRequestLedger(dbPath);
  const saved = requests.submit({ requesterId: 1, requestKey: 'one', nowMs: 100,
    intent });
  const ledger = openAcquisitionLedger(dbPath);
  try { await run({ request: requests.getRequest(saved.requestId), ledger, dbPath }); }
  finally { ledger.close(); requests.close(); await rm(dir, { recursive: true, force: true }); }
}

function options({ request, ledger, readEvidence, prowlarrFetch, qbittorrentFetch,
  inspectMounts = async () => mounts }) {
  return { request, candidate, detail: baseDetail, episodeIds: [1001],
    plannedFiles: [{ name: '01.mkv', size: 1000, episodeIds: [1001] }], readEvidence,
    publicLibraryIds: [102], ledger, now: () => 201,
    prowlarr: { baseUrl: 'http://prowlarr.internal:9696/', apiKey: 'syntheticKey',
      query: 'Example', indexerIds: [3], fetchImpl: prowlarrFetch },
    qbittorrent: { hostPath, baseUrl: 'http://qbittorrent.internal:8080/',
      sessionId: 'syntheticSID', inspectMounts, realpathImpl: async () => hostPath,
      fetchImpl: qbittorrentFetch } };
}

test('a title with unknown age flag cannot reach Prowlarr or qBittorrent', async () =>
  withLedgers(async ({ request, ledger }) => {
    let providerCalls = 0;
    const input = options({ request, ledger, readEvidence: async () => absent(),
      prowlarrFetch: async () => { providerCalls++; },
      qbittorrentFetch: async () => { providerCalls++; } });
    assert.deepEqual(await submitMissingCandidate({ ...input,
      detail: { ...baseDetail, restricted: null } }),
    { state: 'held', reason: 'restricted_or_unverified' });
    assert.equal(providerCalls, 0);
  }));

test('a request target removed from fresh AniDB detail holds before provider reads', async () =>
  withLedgers(async ({ request, ledger }) => {
    let providerCalls = 0;
    const input = options({ request, ledger, readEvidence: async () => absent(),
      prowlarrFetch: async () => { providerCalls++; },
      qbittorrentFetch: async () => { providerCalls++; } });
    assert.deepEqual(await submitMissingCandidate({ ...input,
      detail: { ...baseDetail, total: 1,
        episodes: [baseDetail.episodes[0]] } }),
    { state: 'held', reason: 'target_missing' });
    assert.equal(providerCalls, 0);
  }));

function absent() {
  return { anidbId: 42, episodeIds: [1001], observedAtMs: 200,
    importFence: { state: 'settled', anidbId: 42, episodeIds: [1001],
      beforeObservedAtMs: 199, afterObservedAtMs: 200 },
    shoko: { state: 'ok', complete: true, files: [] },
    plex: { state: 'ok', complete: true, sourceVerified: true,
      libraryIds: [102], parts: [] } };
}

function prowlarrFetch() {
  let calls = 0;
  return async () => ++calls === 1
    ? Response.json([{ ...candidate, protocol: 'torrent', downloadUrl: proxy }])
    : new Response(bytes, { headers: { 'content-type': 'application/x-bittorrent' } });
}

function qbittorrentFetch(calls) {
  return async (url, init) => {
    const endpoint = new URL(url).pathname;
    calls.push({ endpoint, method: init.method });
    if (endpoint === '/api/v2/app/version') return new Response('v5.3.0');
    if (endpoint.endsWith('/add')) return new Response('Ok.');
    if (calls.filter((call) => call.endpoint.endsWith('/info')).length === 1) return Response.json([]);
    return Response.json(endpoint.endsWith('/files') ? files :
      endpoint.endsWith('/properties')
        ? { save_path: savePath, download_path: '' } : [torrent]);
  };
}

test('one exact missing target is reserved then submitted stopped once', async () =>
  withLedgers(async ({ request, ledger }) => {
    const calls = [];
    const input = options({ request, ledger, readEvidence: async () => absent(),
      prowlarrFetch: prowlarrFetch(), qbittorrentFetch: qbittorrentFetch(calls) });
    const result = await submitMissingCandidate(input);
    assert.equal(result.state, 'stopped_observed');
    assert.equal(result.hash, hash);
    assert.deepEqual(ledger.getAttempt(result.attemptId).episodeIds, [1001]);
    assert.deepEqual(ledger.getFilePlan(result.attemptId), input.plannedFiles);
    assert.equal(calls.filter((call) => call.endpoint.endsWith('/add')).length, 1);
  }));

test('server submission rejects a related installment before reserving or adding a torrent', async () =>
  withLedgers(async ({ request, ledger }) => {
    const qbitCalls = [];
    const sideStory = { ...candidate, title: 'Example: Side Story - 01' };
    const input = options({ request, ledger, readEvidence: async () => absent(),
      prowlarrFetch: async (url) => new URL(url).pathname.endsWith('/search')
        ? Response.json([{ ...sideStory, protocol: 'torrent', downloadUrl: proxy }])
        : new Response(bytes, { headers: { 'content-type': 'application/x-bittorrent' } }),
      qbittorrentFetch: qbittorrentFetch(qbitCalls) });
    const result = await submitMissingCandidate({ ...input,
      candidate: sideStory,
      readRelatedTitles: async () => ({ state: 'related_titles', anidbId: 42,
        items: [{ anidbId: 43, title: 'Example: Side Story', relation: 'SideStory' }] }),
    });
    assert.deepEqual(result, { state: 'held', reason: 'related_installment_mismatch' });
    assert.equal(ledger.inspectRequestAttempts(request.id).state, 'no_attempt');
    assert.equal(qbitCalls.length, 0);
  }));

test('an alias-only stopped submission revalidates its server-approved title', async () =>
  withLedgers(async ({ request, ledger }) => {
    const queries = [];
    const input = options({ request, ledger, readEvidence: async () => absent(),
      prowlarrFetch: async (url) => {
        if (new URL(url).pathname.endsWith('/search')) {
          queries.push(new URL(url).searchParams.get('query'));
          return Response.json([{ ...candidate, protocol: 'torrent',
            downloadUrl: proxy }]);
        }
        return new Response(bytes, { headers: {
          'content-type': 'application/x-bittorrent' } });
      }, qbittorrentFetch: qbittorrentFetch([]) });
    const result = await submitMissingCandidate({ ...input,
      detail: { ...baseDetail, title: 'Example' },
      searchQuery: 'Official English',
      releaseQueries: async ({ anidbId }) => {
        assert.equal(anidbId, 42);
        return ['Official English'];
      } });
    assert.equal(result.state, 'stopped_observed');
    assert.deepEqual(queries, ['Official English']);
  }));

test('a caller-supplied release query outside the trusted AniDB titles cannot reach an indexer', async () =>
  withLedgers(async ({ request, ledger }) => {
    let providerCalls = 0;
    const input = options({ request, ledger, readEvidence: async () => absent(),
      prowlarrFetch: async () => { providerCalls++; },
      qbittorrentFetch: async () => { providerCalls++; } });
    assert.deepEqual(await submitMissingCandidate({ ...input,
      detail: { ...baseDetail, title: 'Canonical Title' },
      searchQuery: 'Unrelated Show',
      releaseQueries: async () => ['Official English'] }),
    { state: 'held', reason: 'untrusted_release_query' });
    assert.equal(providerCalls, 0);
    assert.equal(ledger.getAttempt(1), null);
  }));

test('an unambiguous series file creates the provisional subset without a caller plan', async () =>
  withLedgers(async ({ request, ledger }) => {
    const calls = [];
    const input = options({ request, ledger, readEvidence: async () => absent(),
      prowlarrFetch: prowlarrFetch(), qbittorrentFetch: qbittorrentFetch(calls) });
    const detail = { state: 'details', complete: true, total: 2, restricted: false,
      anidbId: 42, kind: 'series', title: 'Example', episodes: [
        { id: 1001, number: 1, type: 'Episode' },
        { id: 1002, number: 2, type: 'Episode' },
      ] };
    const result = await submitMissingCandidate({ ...input, detail,
      episodeIds: undefined, plannedFiles: undefined });
    assert.equal(result.state, 'stopped_observed');
    assert.deepEqual(ledger.getAttempt(result.attemptId).episodeIds, [1001]);
    assert.deepEqual(ledger.getFilePlan(result.attemptId), [
      { name: '01.mkv', size: 1000, episodeIds: [1001] }]);
    assert.equal(calls.filter((call) => call.endpoint.endsWith('/add')).length, 1);
  }));

test('a one-video AniDB movie request follows the same stopped acquisition path', async () =>
  withLedgers(async ({ request, ledger }) => {
    const calls = [];
    const input = options({ request, ledger,
      readEvidence: async () => ({ ...absent(), episodeIds: [5001],
        importFence: { state: 'settled', anidbId: 42, episodeIds: [5001],
          beforeObservedAtMs: 199, afterObservedAtMs: 200 } }),
      prowlarrFetch: prowlarrFetch(), qbittorrentFetch: qbittorrentFetch(calls) });
    const detail = { state: 'details', complete: true, total: 1, restricted: false,
      anidbId: 42, kind: 'movie', title: 'Example',
      episodes: [{ id: 5001, number: 1, type: 'Episode' }] };
    const result = await submitMissingCandidate({ ...input, detail,
      episodeIds: undefined, plannedFiles: undefined });
    assert.equal(result.state, 'stopped_observed');
    assert.deepEqual(ledger.getAttempt(result.attemptId).episodeIds, [5001]);
    assert.equal(calls.filter((call) => call.endpoint.endsWith('/add')).length, 1);
  }, { state: 'ready', anidbId: 42, kind: 'movie',
    monitorFuture: false, episodeIds: [5001] }));

test('a wrong video-to-episode plan holds before reservation or qBittorrent', async () =>
  withLedgers(async ({ request, ledger }) => {
    let qbCalls = 0;
    const input = options({ request, ledger, readEvidence: async () => absent(),
      prowlarrFetch: prowlarrFetch(), qbittorrentFetch: async () => { qbCalls++; } });
    const result = await submitMissingCandidate({ ...input,
      plannedFiles: [{ name: 'Other.mkv', size: 1000, episodeIds: [1001] }] });
    assert.deepEqual(result, { state: 'held', reason: 'file_plan_mismatch' });
    assert.equal(qbCalls, 0);
    assert.equal(ledger.getAttempt(1), null);
  }));

test('an inaccessible staging mount holds before reserving an attempt', async () =>
  withLedgers(async ({ request, ledger }) => {
    let providerCalls = 0;
    const input = options({ request, ledger, readEvidence: async () => absent(),
      prowlarrFetch: async () => { providerCalls++; },
      qbittorrentFetch: async () => { providerCalls++; } });
    input.qbittorrent.verifyStagingRoot = async () =>
      ({ state: 'held', reason: 'staging_root_unverified' });
    assert.deepEqual(await submitMissingCandidate(input),
      { state: 'held', reason: 'staging_root_unverified' });
    assert.equal(providerCalls, 0);
    assert.equal(ledger.getAttempt(1), null);
  }));

test('a supplied file plan cannot bypass the trusted release-title gate', async () =>
  withLedgers(async ({ request, ledger }) => {
    let qbCalls = 0;
    const wrongCandidate = { ...candidate, title: 'Different Anime - 01' };
    let providerCalls = 0;
    const input = options({ request, ledger, readEvidence: async () => absent(),
      prowlarrFetch: async () => ++providerCalls === 1
        ? Response.json([{ ...wrongCandidate, protocol: 'torrent',
          downloadUrl: proxy }])
        : new Response(bytes, { headers: {
          'content-type': 'application/x-bittorrent' } }),
      qbittorrentFetch: async () => { qbCalls++; } });
    const result = await submitMissingCandidate({ ...input,
      candidate: wrongCandidate });
    assert.equal(providerCalls, 0);
    assert.deepEqual(result,
      { state: 'held', reason: 'release_title_mismatch' });
    assert.equal(qbCalls, 0);
    assert.equal(ledger.getAttempt(1), null);
  }));

test('a supplied episode map is recomputed from the current AniDB detail', async () =>
  withLedgers(async ({ request, ledger }) => {
    let qbCalls = 0;
    const input = options({ request, ledger, readEvidence: async () => absent(),
      prowlarrFetch: prowlarrFetch(),
      qbittorrentFetch: async () => { qbCalls++; } });
    const result = await submitMissingCandidate({ ...input,
      episodeIds: [1002], plannedFiles: [{ name: '01.mkv', size: 1000,
        episodeIds: [1002] }] });
    assert.deepEqual(result, { state: 'held', reason: 'file_plan_mismatch' });
    assert.equal(qbCalls, 0);
    assert.equal(ledger.getAttempt(1), null);
  }));

test('a changed torrent hash after preflight cannot reserve or reach qBittorrent', async () =>
  withLedgers(async ({ request, ledger }) => {
    let qbCalls = 0;
    const input = options({ request, ledger, readEvidence: async () => absent(),
      prowlarrFetch: prowlarrFetch(),
      qbittorrentFetch: async () => { qbCalls++; throw Error('unexpected qBittorrent call'); } });
    assert.deepEqual(await submitMissingCandidate({ ...input,
      expectedHash: 'b'.repeat(40) }),
    { state: 'held', reason: 'preflight_torrent_changed' });
    assert.equal(qbCalls, 0);
    assert.equal(ledger.getAttempt(1), null);
  }));

test('a present target or unavailable Prowlarr cannot send a torrent', async () =>
  withLedgers(async ({ request, ledger }) => {
    let qbCalls = 0;
    const qbittorrentFetch = async () => { qbCalls++; throw Error('unexpected downloader call'); };
    const present = absent();
    present.shoko.files = [{ fileId: 7, anidbId: 42, episodeIds: [1001],
      coverage: [{ episodeId: 1001, start: 0, end: 100 }], storageKey: 'file-a' }];
    present.plex.parts = [{ libraryId: 102, readable: true, storageKey: 'file-a' }];
    const blocked = await submitMissingCandidate(options({ request, ledger,
      readEvidence: async () => present, prowlarrFetch: prowlarrFetch(), qbittorrentFetch }));
    assert.deepEqual(blocked, { state: 'held', reason: 'target_already_available', episodeId: 1001 });
    const outage = await submitMissingCandidate(options({ request, ledger,
      readEvidence: async () => absent(), prowlarrFetch: async () => new Response(null, { status: 503 }),
      qbittorrentFetch }));
    assert.equal(outage.state, 'held');
    assert.equal(qbCalls, 0);
    assert.equal(ledger.getAttempt(1), null);
  }));

test('an unsafe mount holds before qBittorrent add and keeps the attempt inspectable', async () =>
  withLedgers(async ({ request, ledger }) => {
    const qbCalls = [];
    const result = await submitMissingCandidate(options({ request, ledger,
      readEvidence: async () => absent(), prowlarrFetch: prowlarrFetch(),
      qbittorrentFetch: qbittorrentFetch(qbCalls),
      inspectMounts: async () => ({ ...mounts,
        qbittorrent: [...mounts.qbittorrent, mount('/srv/library', '/Downloads/negev/Show')] }) }));
    assert.deepEqual(result, { state: 'held', reason: 'staging_destination_shadowed' });
    assert.deepEqual(qbCalls.map(({ method }) => method), ['GET', 'GET']);
    assert.equal(ledger.getAttempt(1).status, 'reserved');
  }));

test('an observed candidate stays owned without replaying its torrent', async () =>
  withLedgers(async ({ request, ledger }) => {
    const calls = [];
    const input = options({ request, ledger, readEvidence: async () => absent(),
      prowlarrFetch: prowlarrFetch(), qbittorrentFetch: qbittorrentFetch(calls) });
    assert.equal((await submitMissingCandidate(input)).state, 'stopped_observed');
    const replay = await submitMissingCandidate({ ...input,
      readEvidence: async () => { throw new Error('Import observer unavailable'); },
      prowlarr: { ...input.prowlarr, fetchImpl: prowlarrFetch() },
      qbittorrent: { ...input.qbittorrent, fetchImpl: async (url, init) => {
        const endpoint = new URL(url).pathname;
        calls.push({ endpoint, method: init.method });
        assert.equal(init.method, 'GET');
        return Response.json(endpoint.endsWith('/files') ? files :
          endpoint.endsWith('/properties')
            ? { save_path: savePath, download_path: '' } : [torrent]);
      } } });
    assert.deepEqual(replay, { state: 'held', reason: 'target_busy' });
    assert.equal(calls.filter((call) => call.endpoint.endsWith('/add')).length, 1);
  }));

test('one saved request advances through the bounded processor to one stopped torrent', async () =>
  withLedgers(async ({ request, ledger, dbPath }) => {
    const queue = openAcquisitionRequestQueue(dbPath);
    const calls = [];
    try {
      const input = options({ request, ledger, readEvidence: async () => absent(),
        prowlarrFetch: prowlarrFetch(), qbittorrentFetch: qbittorrentFetch(calls) });
      const processRequest = createAcquisitionRequestProcessor({
        readRequest: () => request,
        discoverCandidates: async () => ({ state: 'candidates',
          requestId: request.id, anidbId: 42, items: [{ ...candidate,
            evidence: 'unverified' }] }),
        previewCandidate: async () => ({ state: 'preflight',
          requestId: request.id, anidbId: 42, torrentHash: hash,
          episodeIds: [1001], files: input.plannedFiles }),
        loadDetail: async () => baseDetail,
        submitCandidate: (selection) => submitMissingCandidate({ ...input,
          ...selection }),
      });
      const worker = createAcquisitionPageWorker({ queue, processRequest,
        limit: 1, now: () => 201 });
      const first = await worker.runOnce();
      assert.equal(first.results[0].state, 'stopped_observed');
      assert.equal(queue.getResult(request.id).attemptId,
        first.results[0].attemptId);
      assert.equal(ledger.getAttempt(first.results[0].attemptId).status,
        'torrent_observed');
      assert.equal(calls.filter((call) => call.endpoint.endsWith('/add')).length, 1);
      assert.deepEqual(await worker.runOnce(),
        { state: 'pass_complete', pass: 1, results: [] });
    } finally { queue.close(); }
  }));
