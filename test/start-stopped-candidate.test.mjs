import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { openAcquisitionLedger } from '../src/acquisition/acquisition-ledger.mjs';
import { startStoppedCandidate } from '../src/acquisition/start-stopped-candidate.mjs';

const hash = 'a'.repeat(40);
const candidate = { indexerId: 7, guid: 'synthetic-release' };
const expected = { hash, category: 'negev', savePath: `/negev-staging/${hash}` };
const hostPath = '/srv/negev/staging';
const bind = (source, destination) => ({ Type: 'bind', Source: source, Destination: destination, RW: true });
const mounts = { qbittorrent: [bind(hostPath, '/negev-staging')],
  shoko: [bind('/srv/library', '/pure')], plex: [bind('/srv/library', '/source-pure')] };
const torrent = { hash, category: 'negev', save_path: expected.savePath,
  state: 'stoppedDL', progress: 0, downloaded: 0, amount_left: 1000,
  auto_tmm: false, force_start: false };
const files = [{ index: 0, name: 'Example.mkv', size: 1000, priority: 1, progress: 0 }];

async function withObservedTorrent(run, { withPlan = true } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-start-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const requests = openRequestLedger(dbPath);
  const request = requests.submit({ requesterId: 1, requestKey: 'one', nowMs: 100,
    intent: { state: 'ready', anidbId: 42, kind: 'series', monitorFuture: false, episodeIds: [1001] } });
  const ledger = openAcquisitionLedger(dbPath);
  const attempt = ledger.reserve({ requestId: request.requestId, candidate,
    episodeIds: [1001], nowMs: 200 });
  ledger.bindPreparedTorrent({ attemptId: attempt.attemptId, candidate, hash, nowMs: 201 });
  if (withPlan) ledger.recordFilePlan({ attemptId: attempt.attemptId, hash,
    plannedFiles: [{ name: 'Example.mkv', size: 1000, episodeIds: [1001] }], nowMs: 201 });
  ledger.beginDispatch({ attemptId: attempt.attemptId, nowMs: 202 });
  ledger.recordTorrent({ attemptId: attempt.attemptId, hash, nowMs: 203 });
  try { await run({ ledger, attemptId: attempt.attemptId,
    readRequest: (id) => requests.getRequest(id) }); }
  finally { ledger.close(); requests.close(); await rm(dir, { recursive: true, force: true }); }
}

const options = { expected, hostPath, baseUrl: 'http://qbittorrent.internal:8080/',
  sessionId: 'syntheticSID', now: () => 204, inspectMounts: async () => mounts,
  realpathImpl: async () => hostPath, publicLibraryIds: [102],
  readEvidence: async () => ({ anidbId: 42, episodeIds: [1001],
    observedAtMs: 204, shoko: { state: 'ok', complete: true, files: [] },
    plex: { state: 'ok', complete: true, parts: [] } }) };

test('starts only the exact safe stopped manifest once after durable intent', async () =>
  withObservedTorrent(async ({ ledger, attemptId, readRequest }) => {
    let posts = 0;
    let reads = 0;
    const fetchImpl = async (url, init) => {
      const endpoint = new URL(url).pathname;
      if (endpoint.endsWith('/start')) {
        posts++;
        assert.equal(reads, 5);
        assert.equal(init.method, 'POST');
        assert.equal(init.body.toString(), `hashes=${hash}`);
        assert.equal(init.redirect, 'manual');
        assert.equal(init.headers.Cookie, 'SID=syntheticSID');
        return new Response('');
      }
      assert.equal(init.method, 'GET');
      reads++;
      if (endpoint.endsWith('/properties')) return Response.json({
        save_path: expected.savePath, download_path: '',
      });
      return Response.json(endpoint.endsWith('/files') ? files : [torrent]);
    };
    const first = await startStoppedCandidate({ ...options, ledger, attemptId, readRequest, fetchImpl });
    assert.equal(first.state, 'start_unknown');
    assert.equal(first.sendNow, true);
    const second = await startStoppedCandidate({ ...options, ledger, attemptId, readRequest, fetchImpl,
      now: () => 205 });
    assert.equal(second.state, 'start_unknown');
    assert.equal(second.sendNow, false);
    assert.equal(posts, 1);
  }));

test('unsafe manifest and visible staging hold before the start call', async () =>
  withObservedTorrent(async ({ ledger, attemptId, readRequest }) => {
    let posts = 0;
    const fetchImpl = async (url) => {
      const endpoint = new URL(url).pathname;
      if (endpoint.endsWith('/start')) { posts++; throw Error('unexpected start'); }
      return Response.json(endpoint.endsWith('/files')
        ? [{ ...files[0], name: 'run.exe' }] : [torrent]);
    };
    const unsafe = await startStoppedCandidate({ ...options, ledger, attemptId, readRequest, fetchImpl });
    assert.equal(unsafe.state, 'held');
    assert.equal(posts, 0);
    const visible = await startStoppedCandidate({ ...options, ledger, attemptId, readRequest,
      inspectMounts: async () => ({ ...mounts, shoko: [bind('/srv', '/pure')] }),
      fetchImpl: async () => { throw Error('unexpected call'); } });
    assert.deepEqual(visible, { state: 'held', reason: 'staging_visible_to_shoko' });
  }));

test('a stopped torrent whose incomplete path escapes staging cannot start', async () =>
  withObservedTorrent(async ({ ledger, attemptId, readRequest }) => {
    let posts = 0;
    const fetchImpl = async (url) => {
      const endpoint = new URL(url).pathname;
      if (endpoint.endsWith('/start')) { posts++; throw Error('unexpected start'); }
      if (endpoint.endsWith('/properties')) return Response.json({
        save_path: expected.savePath, download_path: '/Shoko',
      });
      return Response.json(endpoint.endsWith('/files') ? files : [torrent]);
    };
    const result = await startStoppedCandidate({ ...options, ledger, attemptId, readRequest, fetchImpl });
    assert.deepEqual(result, { state: 'held', reason: 'incomplete_path_outside_staging' });
    assert.equal(posts, 0);
  }));

test('a changed video filename or size cannot start against the saved plan', async () =>
  withObservedTorrent(async ({ ledger, attemptId, readRequest }) => {
    for (const altered of [{ ...files[0], name: 'Other.mkv' }, { ...files[0], size: 999 }]) {
      let posts = 0;
      const result = await startStoppedCandidate({ ...options, ledger, attemptId, readRequest,
        fetchImpl: async (url) => {
          const endpoint = new URL(url).pathname;
          if (endpoint.endsWith('/start')) { posts++; throw Error('unexpected start'); }
          if (endpoint.endsWith('/properties')) return Response.json({
            save_path: expected.savePath, download_path: '',
          });
          return Response.json(endpoint.endsWith('/files') ? [altered] : [torrent]);
        } });
      assert.deepEqual(result, { state: 'held', reason: 'file_plan_mismatch' });
      assert.equal(posts, 0);
    }
  }));

test('an older observed torrent without a durable file plan cannot start', async () =>
  withObservedTorrent(async ({ ledger, attemptId, readRequest }) => {
    let calls = 0;
    const result = await startStoppedCandidate({ ...options, ledger, attemptId, readRequest,
      fetchImpl: async () => { calls++; throw Error('unexpected API call'); } });
    assert.deepEqual(result, { state: 'held', reason: 'file_plan_missing' });
    assert.equal(calls, 0);
  }, { withPlan: false }));

test('a lost start response remains unknown and cannot trigger a second POST', async () =>
  withObservedTorrent(async ({ ledger, attemptId, readRequest }) => {
    let posts = 0;
    const fetchImpl = async (url) => {
      const endpoint = new URL(url).pathname;
      if (endpoint.endsWith('/start')) { posts++; throw Error('response lost'); }
      if (endpoint.endsWith('/properties')) return Response.json({
        save_path: expected.savePath, download_path: '',
      });
      return Response.json(endpoint.endsWith('/files') ? files : [torrent]);
    };
    assert.deepEqual(await startStoppedCandidate({ ...options, ledger, attemptId, readRequest, fetchImpl }),
      { state: 'start_unknown', sendNow: true });
    assert.deepEqual(await startStoppedCandidate({ ...options, ledger, attemptId, readRequest, fetchImpl,
      now: () => 205 }), { state: 'start_unknown', sendNow: false });
    assert.equal(posts, 1);
  }));

test('a newly playable manual import blocks the already reserved torrent start', async () =>
  withObservedTorrent(async ({ ledger, attemptId, readRequest }) => {
    let posts = 0;
    const result = await startStoppedCandidate({ ...options, ledger, attemptId,
      readRequest, readEvidence: async () => ({ anidbId: 42,
        episodeIds: [1001], observedAtMs: 204,
        shoko: { state: 'ok', complete: true, files: [{ fileId: 91,
          anidbId: 42, episodeIds: [1001], storageKey: 'same',
          coverage: [{ episodeId: 1001, start: 0, end: 100 }] }] },
        plex: { state: 'ok', complete: true,
          parts: [{ storageKey: 'same', libraryId: 102, readable: true }] } }),
      fetchImpl: async (url) => {
        const endpoint = new URL(url).pathname;
        if (endpoint.endsWith('/start')) { posts++; return new Response(''); }
        if (endpoint.endsWith('/properties')) return Response.json({
          save_path: expected.savePath, download_path: '' });
        return Response.json(endpoint.endsWith('/files') ? files : [torrent]);
      } });
    assert.deepEqual(result, { state: 'held', reason: 'target_already_available',
      episodeId: 1001 });
    assert.equal(posts, 0);
  }));

test('a cancelled request blocks a reserved torrent before start', async () =>
  withObservedTorrent(async ({ ledger, attemptId }) => {
    let posts = 0;
    const result = await startStoppedCandidate({ ...options, ledger, attemptId,
      readRequest: () => null,
      fetchImpl: async (url) => {
        const endpoint = new URL(url).pathname;
        if (endpoint.endsWith('/start')) { posts++; return new Response(''); }
        if (endpoint.endsWith('/properties')) return Response.json({
          save_path: expected.savePath, download_path: '' });
        return Response.json(endpoint.endsWith('/files') ? files : [torrent]);
      } });
    assert.deepEqual(result, { state: 'held', reason: 'request_missing' });
    assert.equal(posts, 0);
  }));

test('cancellation during the final availability read still prevents start', async () =>
  withObservedTorrent(async ({ ledger, attemptId, readRequest }) => {
    let reads = 0;
    let posts = 0;
    const result = await startStoppedCandidate({ ...options, ledger, attemptId,
      readRequest: (id) => ++reads === 1 ? readRequest(id) : null,
      fetchImpl: async (url) => {
        const endpoint = new URL(url).pathname;
        if (endpoint.endsWith('/start')) { posts++; return new Response(''); }
        if (endpoint.endsWith('/properties')) return Response.json({
          save_path: expected.savePath, download_path: '' });
        return Response.json(endpoint.endsWith('/files') ? files : [torrent]);
      } });
    assert.deepEqual(result, { state: 'held', reason: 'request_missing' });
    assert.equal(reads, 2);
    assert.equal(posts, 0);
  }));
