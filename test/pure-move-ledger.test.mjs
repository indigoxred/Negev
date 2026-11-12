import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { openAcquisitionLedger } from '../src/acquisition/acquisition-ledger.mjs';
import { openPureMoveLedger } from '../src/acquisition/pure-move-ledger.mjs';

test('one saved torrent gets one durable move intent and publish transition', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-pure-ledger-'));
  const dbPath = path.join(root, 'state.sqlite');
  const hash = 'a'.repeat(40);
  const files = [{ name: 'Show/01.mkv', size: 3, episodeIds: [1001],
    dev: '1', ino: '2', mtimeNs: '3' }];
  let attemptId;
  try {
    const requests = openRequestLedger(dbPath);
    const request = requests.submit({ requesterId: 1, requestKey: 'one', nowMs: 100,
      intent: { state: 'ready', anidbId: 42, kind: 'series', monitorFuture: false,
        episodeIds: [1001] } });
    requests.close();
    const acquisition = openAcquisitionLedger(dbPath);
    const candidate = { indexerId: 7, guid: 'synthetic-release' };
    const attempt = acquisition.reserve({ requestId: request.requestId, candidate,
      episodeIds: [1001], nowMs: 200 });
    attemptId = attempt.attemptId;
    acquisition.bindPreparedTorrent({ attemptId, candidate, hash, nowMs: 201 });
    acquisition.beginDispatch({ attemptId, nowMs: 202 });
    acquisition.recordTorrent({ attemptId, hash, nowMs: 203 });
    acquisition.beginStart({ attemptId, hash,
      manifestDigest: 'c'.repeat(64), nowMs: 204 });
    acquisition.close();
    const input = { attemptId, torrentHash: hash,
      stagingRoot: path.join(root, '.negev-staging', hash),
      holdingPath: path.join(root, 'holding', `negev-${attemptId}-${hash.slice(0, 16)}`),
      files, nowMs: 205 };
    const ledger = openPureMoveLedger(dbPath);
    try {
      assert.deepEqual(ledger.recordIntent(input), { state: 'recorded' });
      assert.deepEqual(ledger.recordIntent(input), { state: 'recorded' });
      assert.deepEqual(ledger.recordIntent({ ...input, files: [{ ...files[0], size: 4 }] }),
        { state: 'held', reason: 'move_intent_conflict' });
      assert.equal(ledger.getIntent(attemptId).status, 'moving');
      assert.deepEqual(ledger.markPrepared({ attemptId, nowMs: 206 }),
        { state: 'prepared' });
    } finally { ledger.close(); }
    const restarted = openPureMoveLedger(dbPath);
    try {
      assert.equal(restarted.getIntent(attemptId).status, 'prepared');
      assert.deepEqual(restarted.beginPublish({ attemptId, nowMs: 207 }),
        { state: 'publish_unknown', sendNow: true });
      assert.deepEqual(restarted.beginPublish({ attemptId, nowMs: 208 }),
        { state: 'publish_unknown', sendNow: false });
      assert.deepEqual(restarted.markPublished({ attemptId, nowMs: 209 }),
        { state: 'published_observed' });
      assert.equal(restarted.getIntent(attemptId).status, 'published_observed');
    } finally { restarted.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
