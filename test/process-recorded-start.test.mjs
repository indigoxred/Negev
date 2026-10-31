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
          savePath: `/negev-staging/${hash}` });
        assert.equal(input.hostPath, '/srv/staging');
        assert.equal((await input.readRequest(request.requestId)).id, request.requestId);
        return { state: 'held', reason: 'provider_unavailable' };
      } });
    assert.deepEqual(result, { state: 'held', reason: 'provider_unavailable' });
    assert.equal(calls, 1);
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
