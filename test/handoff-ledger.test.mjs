import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { openAcquisitionLedger } from '../src/acquisition/acquisition-ledger.mjs';
import { openHandoffLedger } from '../src/acquisition/handoff-ledger.mjs';

test('one exact prepared handoff gets one durable publish intent across restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-handoff-ledger-'));
  const dbPath = path.join(root, 'state.sqlite');
  const hash = 'a'.repeat(40);
  const evidenceDigest = 'b'.repeat(64);
  const candidate = { indexerId: 7, guid: 'synthetic-release' };
  try {
    const requests = openRequestLedger(dbPath);
    const request = requests.submit({ requesterId: 1, requestKey: 'one', nowMs: 100,
      intent: { state: 'ready', anidbId: 42, kind: 'series', monitorFuture: false,
        episodeIds: [1001] } });
    requests.close();
    const acquisition = openAcquisitionLedger(dbPath);
    const attempt = acquisition.reserve({ requestId: request.requestId, candidate, nowMs: 200 });
    acquisition.bindPreparedTorrent({ attemptId: attempt.attemptId, candidate, hash, nowMs: 201 });
    acquisition.beginDispatch({ attemptId: attempt.attemptId, nowMs: 202 });
    acquisition.recordTorrent({ attemptId: attempt.attemptId, hash, nowMs: 203 });
    const beforeStart = openHandoffLedger(dbPath);
    assert.deepEqual(beforeStart.recordPrepared({ attemptId: attempt.attemptId,
      torrentHash: hash, evidenceDigest, holdingPath: path.join(root, 'holding'), nowMs: 204 }),
    { state: 'held', reason: 'start_intent_missing' });
    beforeStart.close();
    acquisition.beginStart({ attemptId: attempt.attemptId, hash,
      manifestDigest: 'c'.repeat(64), nowMs: 204 });
    acquisition.close();

    const ledger = openHandoffLedger(dbPath);
    const holdingPath = path.join(root, 'private-holding-batch');
    const prepared = ledger.recordPrepared({ attemptId: attempt.attemptId,
      torrentHash: hash, evidenceDigest, holdingPath, nowMs: 205 });
    assert.equal(prepared.state, 'prepared');
    assert.match(prepared.publishName, /^negev-[0-9]+-[0-9a-f]{16}$/);
    assert.deepEqual(ledger.recordPrepared({ attemptId: attempt.attemptId,
      torrentHash: hash, evidenceDigest, holdingPath, nowMs: 206 }), prepared);
    assert.deepEqual(ledger.recordPrepared({ attemptId: attempt.attemptId,
      torrentHash: hash, evidenceDigest: 'd'.repeat(64), holdingPath, nowMs: 206 }),
    { state: 'held', reason: 'handoff_conflict' });
    assert.deepEqual(ledger.beginPublish({ attemptId: attempt.attemptId,
      evidenceDigest, nowMs: 207 }),
    { state: 'publish_unknown', publishName: prepared.publishName, sendNow: true });
    ledger.close();

    const restarted = openHandoffLedger(dbPath);
    try {
      assert.deepEqual(restarted.beginPublish({ attemptId: attempt.attemptId,
        evidenceDigest, nowMs: 208 }),
      { state: 'publish_unknown', publishName: prepared.publishName, sendNow: false });
      assert.deepEqual(restarted.getHandoff(attempt.attemptId), {
        status: 'publish_unknown', torrentHash: hash, evidenceDigest,
        holdingPath, publishName: prepared.publishName });
    } finally { restarted.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
