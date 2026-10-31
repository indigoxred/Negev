import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { openAcquisitionLedger } from '../src/acquisition/acquisition-ledger.mjs';
import { openHandoffLedger } from '../src/acquisition/handoff-ledger.mjs';
import { evaluateHandoffEvidence } from '../src/acquisition/handoff-evidence.mjs';

test('one exact prepared handoff gets one durable publish intent across restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-handoff-ledger-'));
  const dbPath = path.join(root, 'state.sqlite');
  const hash = 'a'.repeat(40);
  const details = { anidbId: 42, torrentHash: hash,
    files: [{ name: '01.mkv', size: 3, ed2k: 'A'.repeat(32),
      anidbFileId: 51, episodeIds: [1001] }], subtitles: [] };
  const evidence = evaluateHandoffEvidence(details);
  const evidenceDigest = evidence.digest;
  const candidate = { indexerId: 7, guid: 'synthetic-release' };
  try {
    const requests = openRequestLedger(dbPath);
    const request = requests.submit({ requesterId: 1, requestKey: 'one', nowMs: 100,
      intent: { state: 'ready', anidbId: 42, kind: 'series', monitorFuture: false,
        episodeIds: [1001] } });
    requests.close();
    const acquisition = openAcquisitionLedger(dbPath);
    const attempt = acquisition.reserve({ requestId: request.requestId, candidate,
      episodeIds: [1001], nowMs: 200 });
    acquisition.bindPreparedTorrent({ attemptId: attempt.attemptId, candidate, hash, nowMs: 201 });
    acquisition.beginDispatch({ attemptId: attempt.attemptId, nowMs: 202 });
    acquisition.recordTorrent({ attemptId: attempt.attemptId, hash, nowMs: 203 });
    const beforeStart = openHandoffLedger(dbPath);
    const holdingPath = path.join(root, 'private-holding-batch');
    const prepared = { state: 'handoff_prepared', publishReady: false,
      holdingPath, evidenceDigest, ...details };
    assert.deepEqual(beforeStart.recordPrepared({ attemptId: attempt.attemptId,
      prepared, nowMs: 204 }),
    { state: 'held', reason: 'start_intent_missing' });
    beforeStart.close();
    acquisition.beginStart({ attemptId: attempt.attemptId, hash,
      manifestDigest: 'c'.repeat(64), nowMs: 204 });
    acquisition.close();

    const ledger = openHandoffLedger(dbPath);
    let saved;
    try {
    saved = ledger.recordPrepared({ attemptId: attempt.attemptId, prepared, nowMs: 205 });
    assert.equal(saved.state, 'prepared');
    assert.match(saved.publishName, /^negev-[0-9]+-[0-9a-f]{16}$/);
    assert.deepEqual(ledger.recordPrepared({ attemptId: attempt.attemptId,
      prepared, nowMs: 206 }), saved);
    assert.deepEqual(ledger.recordPrepared({ attemptId: attempt.attemptId,
      prepared: { ...prepared, evidenceDigest: 'd'.repeat(64) }, nowMs: 206 }),
    { state: 'held', reason: 'handoff_evidence_mismatch' });
    assert.deepEqual(ledger.beginPublish({ attemptId: attempt.attemptId,
      evidenceDigest, nowMs: 207 }),
    { state: 'publish_unknown', publishName: saved.publishName, sendNow: true });
    } finally { ledger.close(); }

    const restarted = openHandoffLedger(dbPath);
    try {
      assert.deepEqual(restarted.beginPublish({ attemptId: attempt.attemptId,
        evidenceDigest, nowMs: 208 }),
      { state: 'publish_unknown', publishName: saved.publishName, sendNow: false });
      assert.deepEqual(restarted.getHandoff(attempt.attemptId), {
        status: 'publish_unknown', torrentHash: hash, evidenceDigest,
        holdingPath, publishName: saved.publishName, manifest: evidence.manifest });
    } finally { restarted.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
