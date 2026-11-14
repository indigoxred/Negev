import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { openAcquisitionLedger } from '../src/acquisition/acquisition-ledger.mjs';
import { openPureMoveLedger } from '../src/acquisition/pure-move-ledger.mjs';
import { openHandoffPublishQueue } from '../src/acquisition/handoff-publish-queue.mjs';

test('an uncertain consumed pure move retries Shoko briefly, then advances the queue', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-pure-retry-'));
  const dbPath = path.join(root, 'state.sqlite');
  const hash = 'a'.repeat(40);
  const connections = [];
  try {
    const requests = openRequestLedger(dbPath); connections.push(requests);
    const request = requests.submit({ requesterId: 1, requestKey: 'pure-retry',
      nowMs: 100, intent: { state: 'ready', anidbId: 42, kind: 'movie',
        monitorFuture: false, episodeIds: [1001] } });
    const acquisitions = openAcquisitionLedger(dbPath); connections.push(acquisitions);
    const candidate = { indexerId: 7, guid: 'pure-retry' };
    const attemptId = acquisitions.reserve({ requestId: request.requestId,
      candidate, episodeIds: [1001], nowMs: 200 }).attemptId;
    acquisitions.bindPreparedTorrent({ attemptId, candidate, hash, nowMs: 201 });
    acquisitions.beginDispatch({ attemptId, nowMs: 202 });
    acquisitions.recordTorrent({ attemptId, hash, nowMs: 203 });
    acquisitions.beginStart({ attemptId, hash,
      manifestDigest: 'c'.repeat(64), nowMs: 204 });
    const moves = openPureMoveLedger(dbPath); connections.push(moves);
    assert.equal(moves.recordIntent({ attemptId, torrentHash: hash,
      stagingRoot: path.join(root, 'staging', hash),
      holdingPath: path.join(root, 'holding', `negev-${attemptId}-${hash.slice(0, 16)}`),
      files: [{ name: 'Movie.mkv', size: 3, episodeIds: [1001],
        dev: '1', ino: '2', mtimeNs: '3' }], nowMs: 205 }).state, 'recorded');
    moves.markPrepared({ attemptId, nowMs: 206 });
    moves.beginPublish({ attemptId, nowMs: 207 });
    const queue = openHandoffPublishQueue(dbPath, { pureMode: true });
    connections.push(queue);
    const first = queue.claimNext({ nowMs: 1_000 });
    assert.equal(first.attemptId, attemptId);
    assert.equal(queue.recordResult({ attemptId, version: first.version,
      state: 'held', reason: 'publish_outcome_unknown', checkedMs: 1_001 }).state,
    'recorded');
    assert.equal(queue.getResult(attemptId).nextDueMs, 301_001);
    assert.equal(queue.claimNext({ nowMs: 301_000 }).state, 'idle');
    const second = queue.claimNext({ nowMs: 301_001 });
    assert.equal(second.attemptId, attemptId);
    const files = [{ name: 'Movie.mkv', fileId: 77, releaseEvidence: 'registered' }];
    assert.equal(moves.recordContentPresent({ attemptId, files,
      nowMs: 301_002 }).state, 'content_present');
    assert.equal(queue.recordResult({ attemptId, version: second.version,
      state: 'held', reason: 'content_present_unattributed',
      checkedMs: 301_003 }).state, 'recorded');
    assert.equal(queue.claimNext({ nowMs: 1_000_000 }).state, 'idle');
    assert.equal(moves.getIntent(attemptId).status, 'publish_unknown');
    assert.deepEqual(moves.getContentObservation(attemptId).files, files);
  } finally {
    for (const connection of connections.reverse()) connection.close();
    await rm(root, { recursive: true, force: true });
  }
});
