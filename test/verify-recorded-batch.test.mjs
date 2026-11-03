import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { openAcquisitionLedger } from '../src/acquisition/acquisition-ledger.mjs';
import { verifyRecordedBatch } from '../src/acquisition/verify-recorded-batch.mjs';

const hash = 'a'.repeat(40);
const candidate = { indexerId: 7, guid: 'recorded-release' };
const plannedFiles = [{ name: 'Show/01.mkv', size: 1000, episodeIds: [1001] }];
const complete = { state: 'complete', files: [
  { index: 0, name: 'Show/01.mkv', size: 1000 }], subtitles: [] };

async function withSavedAttempt(run, { plan = true, started = true } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-verify-plan-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const requests = openRequestLedger(dbPath);
  const saved = requests.submit({ requesterId: 1, requestKey: 'one', nowMs: 100,
    intent: { state: 'ready', anidbId: 42, kind: 'series', monitorFuture: false,
      episodeIds: [1001] } });
  let acquisitions = openAcquisitionLedger(dbPath);
  try {
    const reserved = acquisitions.reserve({ requestId: saved.requestId, candidate,
      episodeIds: [1001], nowMs: 200 });
    acquisitions.bindPreparedTorrent({ attemptId: reserved.attemptId,
      candidate, hash, nowMs: 201 });
    if (plan) acquisitions.recordFilePlan({ attemptId: reserved.attemptId,
      hash, plannedFiles, nowMs: 201 });
    acquisitions.beginDispatch({ attemptId: reserved.attemptId, nowMs: 202 });
    acquisitions.recordTorrent({ attemptId: reserved.attemptId, hash, nowMs: 203 });
    if (started) acquisitions.beginStart({ attemptId: reserved.attemptId,
      hash, manifestDigest: 'b'.repeat(64), nowMs: 204 });
    acquisitions.close();
    acquisitions = openAcquisitionLedger(dbPath);
    await run({ requests, acquisitions, attemptId: reserved.attemptId });
  } finally { acquisitions.close(); requests.close(); await rm(dir, { recursive: true, force: true }); }
}

function options({ requests, acquisitions, attemptId, observe, verify }) {
  return { requests, acquisitions, attemptId, stagingHostPath: path.resolve('/staging'), observe,
    lookup: async () => null, verify };
}

test('completed verification uses the configured downloader save root', async () =>
  withSavedAttempt(async ({ requests, acquisitions, attemptId }) => {
    const result = await verifyRecordedBatch({ ...options({ requests,
      acquisitions, attemptId,
      observe: async ({ expected }) => {
        assert.equal(expected.savePath, `/data/torrents/negev/${hash}`);
        return { state: 'held', reason: 'not_complete' };
      }, verify: async () => { throw Error('unexpected byte read'); } }),
    qbitStagingRoot: '/data/torrents/negev' });
    assert.equal(result.state, 'held');
  }));

test('restart verification uses the stored file plan and exact target', async () =>
  withSavedAttempt(async ({ requests, acquisitions, attemptId }) => {
    const result = await verifyRecordedBatch(options({ requests, acquisitions, attemptId,
      observe: async () => complete,
      verify: async ({ expected, root }) => {
        assert.deepEqual(expected, { animeId: 42, episodeIds: [1001] });
        assert.equal(root, path.join(path.resolve('/staging'), hash));
        return { state: 'identity_verified', isCorrupted: false, fileId: 88, size: 1000,
          ed2k: 'A'.repeat(32), coverage: [{ episodeId: 1001, start: 0, end: 100 }] };
      } }));
    assert.equal(result.state, 'batch_identity_verified');
    assert.deepEqual(result.files[0].episodeIds, [1001]);
  }));

test('missing durable plan or start intent holds before observing bytes', async () => {
  for (const variant of [{ plan: false }, { started: false }]) {
    await withSavedAttempt(async ({ requests, acquisitions, attemptId }) => {
      let observations = 0;
      const result = await verifyRecordedBatch(options({ requests, acquisitions, attemptId,
        observe: async () => { observations++; return complete; }, verify: async () => { throw Error('unexpected'); } }));
      assert.equal(result.state, 'held');
      assert.equal(observations, 0);
    }, variant);
  }
});

test('a completed video with a changed size holds before hashing', async () =>
  withSavedAttempt(async ({ requests, acquisitions, attemptId }) => {
    let hashes = 0;
    const result = await verifyRecordedBatch(options({ requests, acquisitions, attemptId,
      observe: async () => ({ ...complete, files: [{ ...complete.files[0], size: 999 }] }),
      verify: async () => { hashes++; throw Error('unexpected hash'); } }));
    assert.deepEqual(result, { state: 'held', reason: 'manifest_or_budget_mismatch' });
    assert.equal(hashes, 0);
  }));
