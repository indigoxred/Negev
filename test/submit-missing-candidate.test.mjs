import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { openAcquisitionLedger } from '../src/acquisition/acquisition-ledger.mjs';
import { submitMissingCandidate } from '../src/acquisition/submit-missing-candidate.mjs';
import { previewRequestCandidate } from '../src/acquisition/request-candidate-preflight.mjs';
import { prepareStoppedCandidate } from '../src/acquisition/prepare-stopped-candidate.mjs';
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

function qbittorrentFetch(calls, emptyInfoReads = 1) {
  return async (url, init) => {
    const endpoint = new URL(url).pathname;
    calls.push({ endpoint, method: init.method });
    if (endpoint === '/api/v2/app/version') return new Response('v5.3.0');
    if (endpoint.endsWith('/add')) return new Response('Ok.');
    if (endpoint.endsWith('/info') &&
        calls.filter((call) => call.endpoint.endsWith('/info')).length <= emptyInfoReads) {
      return Response.json([]);
    }
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

test('a first-time request refreshes its qBittorrent session after final evidence', async () =>
  withLedgers(async ({ request, ledger }) => {
    const calls = [];
    let finalEvidenceRead = false;
    const input = options({ request, ledger, readEvidence: async () => {
      finalEvidenceRead = true;
      return absent();
    },
      prowlarrFetch: prowlarrFetch(), qbittorrentFetch: async () => {
        throw new Error('old session must not be used');
      } });
    const result = await submitMissingCandidate({ ...input,
      renewQbittorrent: async (sid) => {
        assert.equal(finalEvidenceRead, true);
        assert.equal(sid, 'syntheticSID');
        return { state: 'authenticated', sessionId: 'freshSID',
          fetchImpl: qbittorrentFetch(calls) };
      },
    });
    assert.equal(result.state, 'stopped_observed');
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

test('an exact-episode stopped submission reuses and revalidates its search query', async () =>
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
      searchQuery: 'Example 01' });
    assert.equal(result.state, 'stopped_observed');
    assert.deepEqual(queries, ['Example 01']);
  }));

test('a shortened same-ID title query survives final stopped submission', async () =>
  withLedgers(async ({ request, ledger }) => {
    const japanese = 'Kashita Maryoku wa "Revo-barai" de Kyousei Choushuu';
    const selected = { ...candidate,
      title: '[SubsPlease] Kashita Maryoku wa Revo Barai de Kyousei Choushuu - 01 1080p' };
    const queries = [];
    const input = options({ request, ledger, readEvidence: async () => absent(),
      prowlarrFetch: async (url) => {
        if (new URL(url).pathname.endsWith('/search')) {
          queries.push(new URL(url).searchParams.get('query'));
          return Response.json([{ ...selected, protocol: 'torrent',
            downloadUrl: proxy }]);
        }
        return new Response(bytes, { headers: {
          'content-type': 'application/x-bittorrent' } });
      }, qbittorrentFetch: qbittorrentFetch([]) });
    const result = await submitMissingCandidate({ ...input,
      candidate: selected,
      detail: { ...baseDetail,
        title: `${japanese}: ${'Long subtitle '.repeat(12)}` },
      searchQuery: `${japanese} 01`,
      releaseQueries: async () => ['Magic Repo Man'] });
    assert.equal(result.state, 'stopped_observed');
    assert.deepEqual(queries, [`${japanese} 01`]);
  }));

test('a short retrieval hint needs a fresh exact Shoko identity at submission', async () =>
  withLedgers(async ({ request, ledger }) => {
    const selected = { ...candidate,
      title: '[Group] Kashita Maryoku wa A Different Tale - 01' };
    const detail = { ...baseDetail,
      title: 'Kashita Maryoku wa "Revo-barai" de Kyousei Choushuu: ' +
        'Long subtitle '.repeat(12) };
    let providerCalls = 0;
    const input = options({ request, ledger, readEvidence: async () => absent(),
      prowlarrFetch: async () => { providerCalls++; return Response.json([]); },
      qbittorrentFetch: qbittorrentFetch([]) });
    assert.deepEqual(await submitMissingCandidate({ ...input,
      candidate: selected, detail, searchQuery: 'Kashita Maryoku wa 01',
      releaseQueries: async () => ['Magic Repo Man'] }),
    { state: 'held', reason: 'release_title_mismatch' });
    assert.equal(providerCalls, 0);
    const result = await submitMissingCandidate({ ...input,
      candidate: selected, detail, searchQuery: 'Kashita Maryoku wa 01',
      releaseQueries: async () => ['Magic Repo Man'],
      prowlarr: { ...input.prowlarr, fetchImpl: async (url) =>
        new URL(url).pathname.endsWith('/search')
          ? Response.json([{ ...selected, protocol: 'torrent', downloadUrl: proxy }])
          : new Response(bytes, { headers: {
            'content-type': 'application/x-bittorrent' } }) },
      offlineLookup: async ({ filename }) => ({ status: 200, release: {
        ProviderName: 'Offline Importer', IsCorrupted: false,
        ID: 'offline://42-1001', OriginalFilename: filename,
        CrossReferences: [{ AnidbAnimeID: 42, AnidbEpisodeID: 1001,
          PercentageStart: 0, PercentageEnd: 100 }],
      } }),
    });
    assert.equal(result.state, 'stopped_observed');
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

test('an externally owned torrent hash advances without reserving a target', async () =>
  withLedgers(async ({ request, ledger }) => {
    const calls = [];
    const input = options({ request, ledger, readEvidence: async () => absent(),
      prowlarrFetch: prowlarrFetch(),
      qbittorrentFetch: async (url, init) => {
        calls.push({ path: new URL(url).pathname, method: init.method });
        return Response.json([{ ...torrent, category: 'anime-sonar-imported',
          save_path: '/Downloads' }]);
      } });
    assert.deepEqual(await submitMissingCandidate({ ...input,
      expectedHash: hash }),
    { state: 'held', reason: 'candidate_hash_in_use' });
    assert.equal(ledger.getAttempt(1), null);
    assert.deepEqual(calls, [{ path: '/api/v2/torrents/info', method: 'GET' }]);
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
        prowlarrFetch: prowlarrFetch(), qbittorrentFetch: qbittorrentFetch(calls, 2) });
      const processRequest = createAcquisitionRequestProcessor({
        readRequest: () => request,
        now: () => 201,
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


test('final submission independently rejects an unsupported absolute offset before reservation or qbit I/O',async()=>withLedgers(async({request,ledger})=>{
 const encode=v=>Buffer.isBuffer(v)?Buffer.concat([Buffer.from(v.length+':'),v]):typeof v==='string'?encode(Buffer.from(v)):typeof v==='number'?Buffer.from('i'+v+'e'):Array.isArray(v)?Buffer.concat([Buffer.from('l'),...v.map(encode),Buffer.from('e')]):Buffer.concat([Buffer.from('d'),...Object.keys(v).sort().flatMap(k=>[encode(k),encode(v[k])]),Buffer.from('e')]);
 const info={files:[{length:1000,path:['Example - 13.mkv']},{length:1000,path:['Example - 14.mkv']}],name:'Example','piece length':16384,pieces:Buffer.alloc(20,1)};
 const torrentBytes=encode({info}),chosen={...candidate,title:'Example 13-14 Complete Batch',size:2000};let providerCalls=0,qbitCalls=0;
 const prowlarrFetch=async()=>++providerCalls===1?Response.json([{...chosen,protocol:'torrent',downloadUrl:proxy}]):new Response(torrentBytes,{headers:{"content-type":"application/x-bittorrent"}});
 const result=await submitMissingCandidate({...options({request,ledger,readEvidence:async()=>{throw Error('must not reserve');},prowlarrFetch,qbittorrentFetch:async()=>{qbitCalls++;throw Error('must not add');}}),candidate:chosen,episodeIds:undefined,plannedFiles:undefined,
 readRelatedTitles:async()=>({state:'related_titles',anidbId:42,items:[{anidbId:43,title:'Example Second Season',relation:'sequel'}]}),loadDetail:async()=>({...baseDetail,page:1,nextPage:null}),offlineLookup:async()=>({status:200,release:{CrossReferences:[]}})});
 assert.equal(result.state,'held');assert.equal(result.reason,'absolute_numbering_unverified');assert.equal(qbitCalls,0);assert.equal(ledger.getAttempt(1),null);
}));

test('dispatch includes only independently identified missing bonuses and excludes uncertain extras',async()=>withLedgers(async({request,ledger})=>{
 const encode=v=>Buffer.isBuffer(v)?Buffer.concat([Buffer.from(v.length+':'),v]):typeof v==='string'?encode(Buffer.from(v)):typeof v==='number'?Buffer.from('i'+v+'e'):Array.isArray(v)?Buffer.concat([Buffer.from('l'),...v.map(encode),Buffer.from('e')]):Buffer.concat([Buffer.from('d'),...Object.keys(v).sort().flatMap(k=>[encode(k),encode(v[k])]),Buffer.from('e')]);
 const names=['01.mkv','Extras/Example OVA 1.mkv','Extras/Unknown.mkv'];const info={name:'Example',files:names.map((n,i)=>({length:i?50:1000,path:n.split('/')})),'piece length':16384,pieces:Buffer.alloc(20,1)};const torrentBytes=encode({info}),bonusHash=createHash('sha1').update(encode(info)).digest('hex');const chosen={...candidate,size:1100};let reads=0,priority,adds=0;const liveFiles=names.map((name,index)=>({name,index,size:index?50:1000,priority:1,progress:0}));
 const input=options({request,ledger,readEvidence:async()=>absent(),prowlarrFetch:async()=>++reads===1?Response.json([{...chosen,protocol:'torrent',downloadUrl:proxy}]):new Response(torrentBytes,{headers:{'content-type':'application/x-bittorrent'}}),qbittorrentFetch:async(url,init)=>{const p=new URL(url).pathname;if(p.endsWith('/version'))return new Response('v5.3.0');if(p.endsWith('/add')){adds++;return new Response('Ok.')}if(p.endsWith('/filePrio')){priority=String(init.body);liveFiles[2].priority=0;return new Response('Ok.')}if(p.endsWith('/info')&&adds===0)return Response.json([]);if(p.endsWith('/files'))return Response.json(liveFiles);if(p.endsWith('/properties'))return Response.json({save_path:'/Downloads/negev/'+bonusHash,download_path:''});return Response.json([{...torrent,hash:bonusHash,save_path:'/Downloads/negev/'+bonusHash}]);}});
 const result=await submitMissingCandidate({...input,candidate:chosen,detail:{...baseDetail,total:3,nextPage:null,episodes:[...baseDetail.episodes.map(e=>({...e,title:'Episode '+e.number})),{id:2001,number:1,type:'Special',title:'OVA'}]},readVideoExtensions:async()=>({state:'extensions',values:['.mkv']}),readBonusOwnership:async()=>({state:'missing'}),loadDetail:async()=>null,offlineLookup:async({filename})=>filename.includes('Unknown')?{status:204}:{status:200,release:{ProviderName:'Offline Importer',ID:'offline://42-2001',OriginalFilename:filename,IsCorrupted:false,CrossReferences:[{AnidbAnimeID:42,AnidbEpisodeID:2001,PercentageStart:0,PercentageEnd:100}]}}});
 assert.equal(result.state,'stopped_observed',JSON.stringify(result));assert.equal(adds,1);assert.match(priority,/id=2/);assert.equal(ledger.getBonusPlan(result.attemptId).length,1);assert.deepEqual(ledger.getFilePlan(result.attemptId),input.plannedFiles);
}));


for (const proof of ['exact', 'wrong_anime', 'wrong_episode', 'inconclusive', 'missing']) {
  test('a season-labelled alias submission requires exact Shoko preview: ' + proof, async () =>
    withLedgers(async ({ request, ledger }) => {
      const chosen = { ...candidate,
        title: '[Group] Silver Orchard Season 02 S02 [2025] COMPLETE 1080p' };
      const calls = [];
      const previews = [];
      const input = options({ request, ledger, readEvidence: async () => absent(),
        prowlarrFetch: async (url) => new URL(url).pathname.endsWith('/search')
          ? Response.json([{ ...chosen, protocol: 'torrent', downloadUrl: proxy }])
          : new Response(bytes, { headers: { 'content-type': 'application/x-bittorrent' } }),
        qbittorrentFetch: qbittorrentFetch(calls) });
      const animeId = proof === 'wrong_anime' ? 43 : 42;
      const episodeId = proof === 'wrong_episode' ? 1002 : 1001;
      const result = await submitMissingCandidate({ ...input, candidate: chosen,
        detail: { ...baseDetail, title: 'Gin no Niwa (2025)' },
        searchQuery: 'Silver Orchard (2025)',
        releaseQueries: async () => ['Silver Orchard (2025)'],
        ...(proof === 'missing' ? {} : { offlineLookup: async ({ filename }) => {
          previews.push(filename);
          return proof === 'inconclusive' ? { status: 204 } : { status: 200, release: {
            ProviderName: 'Offline Importer', IsCorrupted: false,
            ID: 'offline://' + animeId + '-' + episodeId, OriginalFilename: filename,
            CrossReferences: [{ AnidbAnimeID: animeId, AnidbEpisodeID: episodeId,
              PercentageStart: 0, PercentageEnd: 100 }],
          } };
        } }),
      });
      if (proof === 'exact') {
        assert.equal(result.state, 'stopped_observed');
        assert.deepEqual(ledger.getFilePlan(result.attemptId), input.plannedFiles);
        assert.deepEqual(previews, ['01.mkv']);
        assert.equal(calls.filter((call) => call.endpoint.endsWith('/add')).length, 1);
      } else {
        assert.deepEqual(result, { state: 'held', reason: 'release_title_mismatch' });
        assert.equal(ledger.inspectRequestAttempts(request.id).state, 'no_attempt');
        assert.equal(calls.length, 0);
      }
    }));
}

test('exact year-and-season alias crosses real preflight, processor, planning and stopped submission', async () =>
  withLedgers(async ({ request, ledger }) => {
    const chosen = { ...candidate, seeders: 10, evidence: 'unverified',
      title: '[Group] Silver Orchard Season 02 S02 [2025] COMPLETE 1080p' };
    const detail = { ...baseDetail, page: 1, nextPage: null, title: 'Gin no Niwa (2025)',
      episodes: baseDetail.episodes.map(episode => ({ ...episode, title: 'Episode' })) };
    const aliases = async () => ['Silver Orchard (2025)'];
    const calls = [];
    const input = options({ request, ledger, readEvidence: async () => absent(),
      prowlarrFetch: async url => new URL(url).pathname.endsWith('/search')
        ? Response.json([{ ...chosen, protocol: 'torrent', downloadUrl: proxy }])
        : new Response(bytes, { headers: { 'content-type': 'application/x-bittorrent' } }),
      qbittorrentFetch: qbittorrentFetch(calls,2) });
    const offlineLookup = async ({ filename }) => ({ status: 200, release: {
      ProviderName: 'Offline Importer', IsCorrupted: false, OriginalFilename: filename,
      ID: 'offline://42-1001', CrossReferences: [{ AnidbAnimeID: 42, AnidbEpisodeID: 1001,
        PercentageStart: 0, PercentageEnd: 100 }],
    } });
    const preview = args => previewRequestCandidate({ ...args, readRequest: () => request,
      loadDetail: async () => detail, releaseQueries: aliases, offlineLookup,
      prepare: args => prepareStoppedCandidate({ ...input.prowlarr, ...args }) });
    const preflight = await preview({ requestId: request.id, candidate: chosen });
    assert.equal(preflight.state, 'preflight', JSON.stringify(preflight));
    assert.equal(preflight.shokoPreview, 'exact');
    const processor = createAcquisitionRequestProcessor({ readRequest: () => request,
      loadDetail: async () => detail,
      discoverCandidates: async () => ({ state: 'candidates', requestId: request.id,
        anidbId: 42, items: [chosen] }),
      previewCandidate: preview,
      submitCandidate: args => submitMissingCandidate({ ...input, ...args,
        releaseQueries: aliases, offlineLookup }),
    });
    const result = await processor({ requestId: request.id });
    assert.equal(result.state, 'stopped_observed', JSON.stringify(result));
    assert.equal(calls.filter(call => call.endpoint.endsWith('/add')).length, 1);
    assert.deepEqual(ledger.getFilePlan(result.attemptId), [{ name: '01.mkv', size: 1000, episodeIds: [1001] }]);
  }));


test('a season-labelled batch checks every file before reservation or addition', async () =>
  withLedgers(async ({ request, ledger }) => {
    const encode = (value) => Buffer.isBuffer(value)
      ? Buffer.concat([Buffer.from(value.length + ':'), value])
      : typeof value === 'string' ? encode(Buffer.from(value))
      : typeof value === 'number' ? Buffer.from('i' + value + 'e')
      : Array.isArray(value) ? Buffer.concat([Buffer.from('l'), ...value.map(encode), Buffer.from('e')])
      : Buffer.concat([Buffer.from('d'), ...Object.keys(value).sort()
        .flatMap((key) => [encode(key), encode(value[key])]), Buffer.from('e')]);
    const torrentBytes = encode({ info: { name: 'Silver Orchard',
      files: [{ length: 1000, path: ['01.mkv'] }, { length: 1000, path: ['02.mkv'] }],
      'piece length': 16384, pieces: Buffer.alloc(20, 1) } });
    const chosen = { ...candidate, size: 2000,
      title: '[Group] Silver Orchard Season 02 S02 [2025] COMPLETE' };
    const previews = [];
    let qbitCalls = 0;
    const input = options({ request, ledger,
      readEvidence: async () => { throw new Error('must not reserve'); },
      prowlarrFetch: async (url) => new URL(url).pathname.endsWith('/search')
        ? Response.json([{ ...chosen, protocol: 'torrent', downloadUrl: proxy }])
        : new Response(torrentBytes, { headers: { 'content-type': 'application/x-bittorrent' } }),
      qbittorrentFetch: async () => { qbitCalls++; throw new Error('must not add'); } });
    const result = await submitMissingCandidate({ ...input, candidate: chosen,
      episodeIds: undefined, plannedFiles: undefined,
      detail: { ...baseDetail, title: 'Gin no Niwa (2025)' },
      searchQuery: 'Silver Orchard (2025)',
      releaseQueries: async () => ['Silver Orchard (2025)'],
      offlineLookup: async ({ filename }) => {
        previews.push(filename);
        return filename === '02.mkv' ? { status: 204 } : { status: 200, release: {
          ProviderName: 'Offline Importer', IsCorrupted: false,
          ID: 'offline://42-1001', OriginalFilename: filename,
          CrossReferences: [{ AnidbAnimeID: 42, AnidbEpisodeID: 1001,
            PercentageStart: 0, PercentageEnd: 100 }],
        } };
      },
    });
    assert.deepEqual(result, { state: 'held', reason: 'release_title_mismatch' });
    assert.deepEqual(previews, ['01.mkv', '02.mkv']);
    assert.equal(qbitCalls, 0);
    assert.equal(ledger.inspectRequestAttempts(request.id).state, 'no_attempt');
  }));

test('final submission rejects season-one metadata against trusted season-two aliases before any reservation',async()=>withLedgers(async({request,ledger})=>{
  const qbitCalls=[];
  const wrong={...candidate,title:'[EMBER] The Apothecary Diaries (2023) (Season 1) [BDRip] [1080p]'};
  const input=options({request,ledger,readEvidence:async()=>absent(),prowlarrFetch:async url=>new URL(url).pathname.endsWith('/search')?Response.json([{...wrong,protocol:'torrent',downloadUrl:proxy}]):new Response(bytes,{headers:{'content-type':'application/x-bittorrent'}}),qbittorrentFetch:qbittorrentFetch(qbitCalls)});
  const result=await submitMissingCandidate({...input,candidate:wrong,detail:{...baseDetail,title:'The Apothecary Diaries (2025)'},searchQuery:'The Apothecary Diaries',
    releaseQueries:async()=>['The Apothecary Diaries S2','Kusuriya no Hitorigoto 2nd Season'],
    readRelatedTitles:async()=>({state:'related_titles',anidbId:42,items:[{anidbId:43,title:'Kusuriya no Hitorigoto',relation:'Prequel'}]})});
  assert.equal(result.reason,'related_installment_mismatch');
  assert.equal(ledger.inspectRequestAttempts(request.id).state,'no_attempt');
  assert.equal(qbitCalls.length,0);
}));

for(const [title,alias]of [['Example Season 2','Example Second Season'],['Example Final Season','Example Season 4']])test(`final submission accepts trusted textual season title: ${title}`,async()=>withLedgers(async({request,ledger})=>{
 const encode=v=>Buffer.isBuffer(v)?Buffer.concat([Buffer.from(v.length+':'),v]):typeof v==='string'?encode(Buffer.from(v)):typeof v==='number'?Buffer.from('i'+v+'e'):Buffer.concat([Buffer.from('d'),...Object.keys(v).sort().flatMap(k=>[encode(k),encode(v[k])]),Buffer.from('e')]);
 const stem=title.includes('Final')?title:alias,filename=stem+' - 01.mkv';const metainfo={length:1000,name:filename,'piece length':16384,pieces:Buffer.alloc(20,1)},infoBytes=encode(metainfo),localHash=createHash('sha1').update(infoBytes).digest('hex'),torrentBytes=encode({info:metainfo}),localPath=`/Downloads/negev/${localHash}`;
 const chosen={...candidate,title:alias+' [1080p]'};const calls=[];let infoReads=0;
 const input=options({request,ledger,readEvidence:async()=>absent(),prowlarrFetch:async url=>new URL(url).pathname.endsWith('/search')?Response.json([{...chosen,protocol:'torrent',downloadUrl:proxy}]):new Response(torrentBytes,{headers:{'content-type':'application/x-bittorrent'}}),qbittorrentFetch:async(url,init)=>{
  const endpoint=new URL(url).pathname;calls.push(endpoint);if(endpoint.endsWith('/version'))return new Response('v5.3.0');if(endpoint.endsWith('/add'))return new Response('Ok.');if(endpoint.endsWith('/info')&&++infoReads===1)return Response.json([]);if(endpoint.endsWith('/files'))return Response.json([{index:0,name:filename,size:1000,priority:1,progress:0}]);if(endpoint.endsWith('/properties'))return Response.json({save_path:localPath,download_path:''});return Response.json([{...torrent,hash:localHash,save_path:localPath}]);
 }});
 const result=await submitMissingCandidate({...input,candidate:chosen,detail:{...baseDetail,title},plannedFiles:[{name:filename,size:1000,episodeIds:[1001]}],searchQuery:alias,releaseQueries:async()=>[alias],readRelatedTitles:async()=>({state:'related_titles',anidbId:42,items:[{anidbId:41,title:'Example',relation:'Prequel'}]})});
 assert.equal(result.state,'stopped_observed',JSON.stringify(result));assert.equal(calls.filter(p=>p.endsWith('/add')).length,1);assert.deepEqual(ledger.getFilePlan(result.attemptId),[{name:filename,size:1000,episodeIds:[1001]}]);
}));

for(const outage of [false,true])test('final submission without filename provider '+(outage?'retains temporary scope failure':'rejects genuine scope gap'),async()=>withLedgers(async({request,ledger})=>{
 const encode=v=>Buffer.isBuffer(v)?Buffer.concat([Buffer.from(v.length+':'),v]):typeof v==='string'?encode(Buffer.from(v)):typeof v==='number'?Buffer.from('i'+v+'e'):Array.isArray(v)?Buffer.concat([Buffer.from('l'),...v.map(encode),Buffer.from('e')]):Buffer.concat([Buffer.from('d'),...Object.keys(v).sort().flatMap(k=>[encode(k),encode(v[k])]),Buffer.from('e')]);
 const torrentBytes=encode({info:{files:[{length:1000,path:['Example - 13.mkv']},{length:1000,path:['Example - 14.mkv']}],name:'Example','piece length':16384,pieces:Buffer.alloc(20,1)}}),chosen={...candidate,title:'Example Season 2 Batch',size:2000};let qbitCalls=0;
 const result=await submitMissingCandidate({...options({request,ledger,readEvidence:async()=>{throw Error('must not reserve')},prowlarrFetch:async url=>new URL(url).pathname.endsWith('/search')?Response.json([{...chosen,protocol:'torrent',downloadUrl:proxy}]):new Response(torrentBytes,{headers:{'content-type':'application/x-bittorrent'}}),qbittorrentFetch:async()=>{qbitCalls++;throw Error('must not add')}}),candidate:chosen,detail:{...baseDetail,title:'Example Season 2'},episodeIds:undefined,plannedFiles:undefined,
  readRelatedTitles:async({anidbId})=>({state:'related_titles',anidbId,items:anidbId===42?[{anidbId:43,title:'Earlier Example',relation:'prequel'}]:[]}),
  loadDetail:async()=>outage?{state:'detail_pending',anidbId:43}:{...baseDetail,anidbId:43,title:'Earlier Example',total:12,complete:true,page:1,nextPage:null,episodes:Array.from({length:12},(_,i)=>({id:5001+i,number:i===0?99:i+1,type:'Episode',title:'Earlier '+i}))}});
 assert.deepEqual(result,{state:'held',reason:outage?'provider_unavailable':'absolute_numbering_unverified'});assert.equal(qbitCalls,0);assert.equal(ledger.getAttempt(1),null);
}));
