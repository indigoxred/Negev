import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { openAcquisitionLedger } from '../src/acquisition/acquisition-ledger.mjs';
import { submitMissingCandidate } from '../src/acquisition/submit-missing-candidate.mjs';

const info = Buffer.from('d6:lengthi1000e4:name11:Example.mkv12:piece lengthi16384e6:pieces20:aaaaaaaaaaaaaaaaaaaae');
const bytes = Buffer.concat([Buffer.from('d4:info'), info, Buffer.from('e')]);
const hash = createHash('sha1').update(info).digest('hex');
const candidate = { indexerId: 3, guid: 'release-1', title: 'Example 01', size: 1000 };
const proxy = 'http://prowlarr.internal:9696/3/download?apikey=syntheticKey&link=abc123&file=Example';
const hostPath = '/srv/negev/staging';
const mount = (Source, Destination, RW = true) => ({ Type: 'bind', Source, Destination, RW });
const mounts = { qbittorrent: [mount(hostPath, '/negev-staging')],
  shoko: [mount('/srv/library', '/pure')],
  plex: [mount('/srv/library', '/source-pure', false)] };
const torrent = { hash, category: 'negev', save_path: '/negev-staging',
  state: 'stoppedDL', progress: 0, downloaded: 0, amount_left: 1000,
  auto_tmm: false, force_start: false };
const files = [{ index: 0, name: 'Example.mkv', size: 1000, priority: 1, progress: 0 }];

async function withLedgers(run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-coordinate-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const requests = openRequestLedger(dbPath);
  const saved = requests.submit({ requesterId: 1, requestKey: 'one', nowMs: 100,
    intent: { state: 'ready', anidbId: 42, kind: 'series', monitorFuture: false,
      episodeIds: [1001, 1002] } });
  const ledger = openAcquisitionLedger(dbPath);
  try { await run({ request: requests.getRequest(saved.requestId), ledger }); }
  finally { ledger.close(); requests.close(); await rm(dir, { recursive: true, force: true }); }
}

function options({ request, ledger, readEvidence, prowlarrFetch, qbittorrentFetch,
  inspectMounts = async () => mounts }) {
  return { request, candidate, episodeIds: [1001],
    plannedFiles: [{ name: 'Example.mkv', size: 1000, episodeIds: [1001] }], readEvidence,
    publicLibraryIds: [102], ledger, now: () => 201,
    prowlarr: { baseUrl: 'http://prowlarr.internal:9696/', apiKey: 'syntheticKey',
      query: 'Example', indexerIds: [3], fetchImpl: prowlarrFetch },
    qbittorrent: { hostPath, baseUrl: 'http://qbittorrent.internal:8080/',
      sessionId: 'syntheticSID', inspectMounts, realpathImpl: async () => hostPath,
      fetchImpl: qbittorrentFetch } };
}

function absent() {
  return { anidbId: 42, episodeIds: [1001], observedAtMs: 200,
    shoko: { state: 'ok', complete: true, files: [] },
    plex: { state: 'ok', complete: true, parts: [] } };
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
    if (endpoint.endsWith('/add')) return new Response('Ok.');
    if (calls.filter((call) => call.endpoint.endsWith('/info')).length === 1) return Response.json([]);
    return Response.json(endpoint.endsWith('/files') ? files : [torrent]);
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

test('an unsafe mount holds before qBittorrent and keeps the attempt inspectable', async () =>
  withLedgers(async ({ request, ledger }) => {
    let qbCalls = 0;
    const result = await submitMissingCandidate(options({ request, ledger,
      readEvidence: async () => absent(), prowlarrFetch: prowlarrFetch(),
      qbittorrentFetch: async () => { qbCalls++; throw Error('unexpected downloader call'); },
      inspectMounts: async () => ({ ...mounts,
        qbittorrent: [...mounts.qbittorrent, mount('/srv/library', '/negev-staging/Show')] }) }));
    assert.deepEqual(result, { state: 'held', reason: 'staging_destination_shadowed' });
    assert.equal(qbCalls, 0);
    assert.equal(ledger.getAttempt(1).status, 'reserved');
  }));

test('replaying an observed stopped candidate never sends a second add', async () =>
  withLedgers(async ({ request, ledger }) => {
    const calls = [];
    const input = options({ request, ledger, readEvidence: async () => absent(),
      prowlarrFetch: prowlarrFetch(), qbittorrentFetch: qbittorrentFetch(calls) });
    assert.equal((await submitMissingCandidate(input)).state, 'stopped_observed');
    const replay = await submitMissingCandidate({ ...input,
      prowlarr: { ...input.prowlarr, fetchImpl: prowlarrFetch() },
      qbittorrent: { ...input.qbittorrent, fetchImpl: async (url, init) => {
        const endpoint = new URL(url).pathname;
        calls.push({ endpoint, method: init.method });
        assert.equal(init.method, 'GET');
        return Response.json(endpoint.endsWith('/files') ? files : [torrent]);
      } } });
    assert.equal(replay.state, 'stopped_observed');
    assert.equal(calls.filter((call) => call.endpoint.endsWith('/add')).length, 1);
  }));
