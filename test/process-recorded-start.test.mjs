import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { openAcquisitionLedger } from '../src/acquisition/acquisition-ledger.mjs';
import { processRecordedStart } from '../src/acquisition/process-recorded-start.mjs';

test('start processor reconstructs the exact saved torrent and request', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-recorded-start-'));
  const dbPath = path.join(root, 'state.sqlite');
  const requests = openRequestLedger(dbPath);
  const request = requests.submit({ requesterId: 1, requestKey: 'one', nowMs: 100,
    intent: { state: 'ready', anidbId: 42, kind: 'series',
      monitorFuture: false, episodeIds: [1001] } });
  const acquisitions = openAcquisitionLedger(dbPath);
  try {
    const candidate = { indexerId: 7, guid: 'candidate' };
    const hash = 'a'.repeat(40);
    const reserved = acquisitions.reserve({ requestId: request.requestId,
      candidate, episodeIds: [1001], nowMs: 200 });
    acquisitions.bindPreparedTorrent({ attemptId: reserved.attemptId,
      candidate, hash, nowMs: 201 });
    acquisitions.recordFilePlan({ attemptId: reserved.attemptId, hash,
      plannedFiles: [{ name: '01.mkv', size: 10, episodeIds: [1001] }], nowMs: 202 });
    acquisitions.beginDispatch({ attemptId: reserved.attemptId, nowMs: 203 });
    acquisitions.recordTorrent({ attemptId: reserved.attemptId, hash, nowMs: 204 });
    let calls = 0;
    const result = await processRecordedStart({ attemptId: reserved.attemptId,
      requests, acquisitions, stagingHostPath: '/srv/staging',
      qbittorrent: { baseUrl: 'http://qbit.local/', sessionId: 'sid' },
      inspectMounts: async () => ({}), realpathImpl: async () => '/srv/staging',
      readEvidence: async () => ({}), publicLibraryIds: [102],
      start: async (input) => {
        calls++;
        assert.deepEqual(input.expected, { hash, category: 'negev',
          savePath: `/Downloads/negev/${hash}` });
        assert.equal(input.hostPath, '/srv/staging');
        assert.equal((await input.readRequest(request.requestId)).id, request.requestId);
        return { state: 'held', reason: 'provider_unavailable' };
      } });
    assert.deepEqual(result, { state: 'held', reason: 'provider_unavailable' });
    assert.equal(calls, 1);
    await processRecordedStart({ attemptId: reserved.attemptId,
      requests, acquisitions, stagingHostPath: '/srv/staging',
      qbitStagingRoot: '/data/torrents/negev',
      qbittorrent: { baseUrl: 'http://qbit.local/', sessionId: 'sid' },
      inspectMounts: async () => ({}), realpathImpl: async () => '/srv/staging',
      readEvidence: async () => ({}), publicLibraryIds: [102],
      start: async (input) => {
        assert.equal(input.expected.savePath, `/data/torrents/negev/${hash}`);
        return { state: 'held', reason: 'provider_unavailable' };
      } });
    assert.deepEqual(await processRecordedStart({ attemptId: 999,
      requests, acquisitions, stagingHostPath: '/srv/staging',
      qbittorrent: { baseUrl: 'http://qbit.local/', sessionId: 'sid' },
      inspectMounts: async () => ({}), realpathImpl: async () => '/srv/staging',
      readEvidence: async () => ({}), publicLibraryIds: [102], start: async () => {
        throw new Error('must not start');
      } }), { state: 'held', reason: 'attempt_missing' });
  } finally {
    acquisitions.close(); requests.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('start processor reconciles a saved uncertain add without asking the indexer again', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-dispatch-recovery-'));
  const dbPath = path.join(root, 'state.sqlite');
  const requests = openRequestLedger(dbPath);
  const request = requests.submit({ requesterId: 1, requestKey: 'recover', nowMs: 100,
    intent: { state: 'ready', anidbId: 42, kind: 'series',
      monitorFuture: false, episodeIds: [1001] } });
  const acquisitions = openAcquisitionLedger(dbPath);
  try {
    const candidate = { indexerId: 7, guid: 'vanished-from-indexer' };
    const hash = 'a'.repeat(40);
    const attemptId = acquisitions.reserve({ requestId: request.requestId,
      candidate, episodeIds: [1001], nowMs: 200 }).attemptId;
    acquisitions.bindPreparedTorrent({ attemptId, candidate, hash, nowMs: 201 });
    acquisitions.recordFilePlan({ attemptId, hash,
      plannedFiles: [{ name: '01.mkv', size: 10, episodeIds: [1001] }], nowMs: 202 });
    acquisitions.beginDispatch({ attemptId, nowMs: 203 });
    const savePath = `/Downloads/negev/${hash}`;
    let starts = 0;
    let writes = 0;
    let reportedSize = 11;
    let includePassive = false;
    let passivePriority = 1;
    const options = { attemptId, requests, acquisitions,
      stagingHostPath: '/srv/staging',
      qbittorrent: { baseUrl: 'http://qbit.local/', sessionId: 'sid' },
      verifyStagingRoot: async () => ({ state: 'verified_staging_root' }),
      readEvidence: async () => ({}), publicLibraryIds: [102], now: () => 205,
      fetchImpl: async (url, init) => {
        if (init.method !== 'GET') writes++;
        const endpoint = new URL(url).pathname;
        if (endpoint.endsWith('/filePrio')) {
          assert.equal(init.body.get('hash'), hash);
          assert.equal(init.body.get('id'), '1');
          passivePriority = 0;
          return new Response('Ok.');
        }
        if (endpoint.endsWith('/info')) return Response.json([{
          hash, category: 'negev', save_path: savePath, state: 'stoppedDL',
          progress: 0, downloaded: 0, amount_left: 10,
          auto_tmm: false, force_start: false }]);
        if (endpoint.endsWith('/properties')) return Response.json({
          save_path: savePath, download_path: '' });
        if (endpoint.endsWith('/files')) return Response.json([{
          index: 0, name: '01.mkv', size: reportedSize, priority: 1, progress: 0 },
        ...(includePassive ? [{ index: 1, name: 'notes.nfo', size: 5,
          priority: passivePriority, progress: 0 }] : [])]);
        throw Error('unexpected downloader read');
      },
      start: async () => {
        starts++;
        assert.equal(acquisitions.getAttempt(attemptId).status, 'torrent_observed');
        return { state: 'held', reason: 'provider_unavailable' };
      },
    };
    assert.deepEqual(await processRecordedStart(options),
      { state: 'held', reason: 'file_plan_mismatch' });
    assert.equal(acquisitions.getAttempt(attemptId).status, 'dispatch_unknown');
    assert.equal(starts, 0);
    reportedSize = 10;
    includePassive = true;
    const result = await processRecordedStart(options);
    assert.deepEqual(result, { state: 'held', reason: 'provider_unavailable' });
    assert.equal(starts, 1);
    assert.equal(writes, 1);
    assert.equal(acquisitions.getAttempt(attemptId).torrentHash, hash);
  } finally {
    acquisitions.close(); requests.close();
    await rm(root, { recursive: true, force: true });
  }
});
