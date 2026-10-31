import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { openAcquisitionLedger } from '../src/acquisition/acquisition-ledger.mjs';
import { openHandoffLedger } from '../src/acquisition/handoff-ledger.mjs';
import { evaluateHandoffEvidence } from '../src/acquisition/handoff-evidence.mjs';
import { reconcileHandoffContent } from '../src/acquisition/observe-handoff-import.mjs';

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
    const acquisitionAfterHandoff = openAcquisitionLedger(dbPath);
    try {
      assert.deepEqual(acquisitionAfterHandoff.recordTerminalRejection({
        attemptId: attempt.attemptId, hash,
        reason: 'file_wrong_identity', nowMs: 206 }),
      { state: 'held', reason: 'handoff_already_recorded' });
    } finally { acquisitionAfterHandoff.close(); }
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
      assert.deepEqual(await reconcileHandoffContent({ attemptId: attempt.attemptId,
        ledger: restarted, nowMs: 209,
        readEpisode: async () => ({ state: 'ok', complete: true, files: [{
          fileId: 9001, anidbFileId: 51, ed2k: 'A'.repeat(32), size: 3,
          anidbId: 42, episodeIds: [1001], sourcePaths: ['/pure/Anime/01.mkv'],
          coverage: [{ episodeId: 1001, start: 0, end: 100 }],
        }] }) }),
      { state: 'content_present', publicationProven: false, fileIds: [9001] });
      assert.equal(restarted.getHandoff(attempt.attemptId).status, 'publish_unknown');
      assert.deepEqual(restarted.recordContentPresent({ attemptId: attempt.attemptId,
        evidenceDigest, publishName: saved.publishName, fileIds: [9002], nowMs: 210 }),
      { state: 'held', reason: 'content_observation_conflict' });
      assert.equal(restarted.getHandoff(attempt.attemptId).status, 'publish_unknown');
      assert.equal(restarted.markPublishedObserved({ attemptId: attempt.attemptId,
        evidenceDigest, publishName: saved.publishName, nowMs: 211 }).state,
      'published_observed');
      assert.equal(restarted.getHandoff(attempt.attemptId).status, 'published_observed');
      assert.deepEqual(restarted.beginPublish({ attemptId: attempt.attemptId,
        evidenceDigest, nowMs: 212 }),
      { state: 'published_observed', publishName: saved.publishName, sendNow: false });
    } finally { restarted.close(); }
    const reread = openHandoffLedger(dbPath);
    try {
      assert.deepEqual(reread.getContentObservation(attempt.attemptId),
        { state: 'content_present', publicationProven: false,
          evidenceDigest, fileIds: [9001] });
    } finally { reread.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('prepared handoff cannot substitute another episode under a valid torrent claim', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-handoff-claim-'));
  const dbPath = path.join(root, 'state.sqlite');
  const hash = 'a'.repeat(40);
  const candidate = { indexerId: 7, guid: 'one-episode-release' };
  try {
    const requests = openRequestLedger(dbPath);
    const saved = requests.submit({ requesterId: 1, requestKey: 'subset', nowMs: 100,
      intent: { state: 'ready', anidbId: 42, kind: 'series', monitorFuture: false,
        episodeIds: [1001, 1002] } });
    requests.close();
    const acquisition = openAcquisitionLedger(dbPath);
    const attempt = acquisition.reserve({ requestId: saved.requestId, candidate,
      episodeIds: [1001], nowMs: 200 });
    acquisition.bindPreparedTorrent({ attemptId: attempt.attemptId, candidate, hash, nowMs: 201 });
    acquisition.beginDispatch({ attemptId: attempt.attemptId, nowMs: 202 });
    acquisition.recordTorrent({ attemptId: attempt.attemptId, hash, nowMs: 203 });
    acquisition.beginStart({ attemptId: attempt.attemptId, hash,
      manifestDigest: 'c'.repeat(64), nowMs: 204 });
    acquisition.close();
    const wrong = { anidbId: 42, torrentHash: hash,
      files: [{ name: '02.mkv', size: 3, ed2k: 'A'.repeat(32),
        anidbFileId: 52, episodeIds: [1002] }], subtitles: [] };
    const ledger = openHandoffLedger(dbPath);
    try {
      assert.deepEqual(ledger.recordPrepared({ attemptId: attempt.attemptId,
        prepared: { state: 'handoff_prepared', publishReady: false,
          holdingPath: path.join(root, 'private-holding'),
          evidenceDigest: evaluateHandoffEvidence(wrong).digest, ...wrong },
        nowMs: 205 }),
      { state: 'held', reason: 'target_claim_mismatch' });
      assert.equal(ledger.getHandoff(attempt.attemptId), null);
      const right = { ...wrong, files: [{ ...wrong.files[0],
        name: '01.mkv', anidbFileId: 51, episodeIds: [1001] }] };
      assert.equal(ledger.recordPrepared({ attemptId: attempt.attemptId,
        prepared: { state: 'handoff_prepared', publishReady: false,
          holdingPath: path.join(root, 'private-holding'),
          evidenceDigest: evaluateHandoffEvidence(right).digest, ...right },
        nowMs: 205 }).state, 'prepared');
    } finally { ledger.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
