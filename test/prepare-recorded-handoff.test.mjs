import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { openAcquisitionLedger } from '../src/acquisition/acquisition-ledger.mjs';
import { openHandoffLedger } from '../src/acquisition/handoff-ledger.mjs';
import { prepareRecordedHandoff } from '../src/acquisition/prepare-recorded-handoff.mjs';
import { evaluateHandoffEvidence } from '../src/acquisition/handoff-evidence.mjs';
import { ed2kFile } from '../src/identity/ed2k.mjs';

test('recorded exact batch is copied privately and journaled once, without publishing', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-recorded-handoff-'));
  const dbPath = path.join(root, 'state.sqlite');
  const torrentHash = 'a'.repeat(40);
  const stagingHostPath = path.join(root, 'staging');
  const stagingRoot = path.join(stagingHostPath, torrentHash);
  const holdingRoot = path.join(root, 'holding');
  const importRoot = path.join(root, 'import');
  const { mkdir } = await import('node:fs/promises');
  await Promise.all([stagingRoot, holdingRoot, importRoot].map((dir) => mkdir(dir, { recursive: true })));
  const name = '01.mkv';
  const source = path.join(stagingRoot, name);
  await writeFile(source, Buffer.from('registered sample'));
  const hash = await ed2kFile(source);
  const requests = openRequestLedger(dbPath);
  const saved = requests.submit({ requesterId: 1, requestKey: 'one', nowMs: 100,
    intent: { state: 'ready', anidbId: 42, kind: 'series', monitorFuture: false,
      episodeIds: [1001] } });
  const acquisitions = openAcquisitionLedger(dbPath);
  const candidate = { indexerId: 7, guid: 'one' };
  const reserved = acquisitions.reserve({ requestId: saved.requestId, candidate,
    episodeIds: [1001], nowMs: 200 });
  acquisitions.bindPreparedTorrent({ attemptId: reserved.attemptId, candidate,
    hash: torrentHash, nowMs: 201 });
  acquisitions.recordFilePlan({ attemptId: reserved.attemptId, hash: torrentHash,
    plannedFiles: [{ name, size: hash.size, episodeIds: [1001] }], nowMs: 201 });
  acquisitions.beginDispatch({ attemptId: reserved.attemptId, nowMs: 202 });
  acquisitions.recordTorrent({ attemptId: reserved.attemptId, hash: torrentHash, nowMs: 203 });
  acquisitions.beginStart({ attemptId: reserved.attemptId, hash: torrentHash,
    manifestDigest: 'b'.repeat(64), nowMs: 204 });
  const handoffs = openHandoffLedger(dbPath);
  let observations = 0;
  const run = () => prepareRecordedHandoff({ requests, acquisitions, handoffs,
    attemptId: reserved.attemptId, stagingHostPath, holdingRoot, importRoot,
    observe: async () => { observations++; return { state: 'complete', files: [
      { index: 0, name, size: hash.size }], subtitles: [] }; },
    lookup: async () => null,
    verify: async () => ({ state: 'identity_verified', isCorrupted: false, fileId: 51,
      ed2k: hash.ed2k, size: hash.size,
      coverage: [{ episodeId: 1001, start: 0, end: 100 }] }),
    nowMs: 205, readPacer: { afterBytes: async () => {} } });
  try {
    const unavailable = await prepareRecordedHandoff({ requests, acquisitions,
      handoffs, attemptId: reserved.attemptId, stagingHostPath, holdingRoot,
      importRoot,
      observe: async () => ({ state: 'complete', files: [
        { index: 0, name, size: hash.size }], subtitles: [] }),
      lookup: async () => null,
      verify: async () => ({ state: 'identity_verified', isCorrupted: false,
        fileId: 51, ed2k: hash.ed2k, size: hash.size,
        coverage: [{ episodeId: 1001, start: 0, end: 100 }] }),
      verifyStagingRoot: async () => ({ state: 'held',
        reason: 'staging_root_unverified' }),
      nowMs: 205, readPacer: { afterBytes: async () => {} } });
    assert.deepEqual(unavailable, { state: 'held',
      reason: 'staging_root_unverified' });
    assert.deepEqual(await readdir(holdingRoot), []);
    assert.equal(handoffs.getHandoff(reserved.attemptId), null);
    const first = await run();
    assert.equal(first.state, 'handoff_prepared');
    assert.deepEqual(await readFile(path.join(first.holdingPath, name)),
      await readFile(source));
    assert.deepEqual(await readdir(importRoot), []);
    assert.equal(handoffs.getHandoff(reserved.attemptId).status, 'prepared');
    const again = await run();
    assert.deepEqual(again, { state: 'held', reason: 'handoff_already_recorded' });
    assert.equal(observations, 2);
    assert.equal((await readdir(holdingRoot)).length, 1);
  } finally {
    handoffs.close(); acquisitions.close(); requests.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('only a confirmed wrong identity records a terminal hold; outage keeps the attempt retryable', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-rejected-handoff-'));
  const dbPath = path.join(root, 'state.sqlite');
  const requests = openRequestLedger(dbPath);
  const saved = requests.submit({ requesterId: 1, requestKey: 'wrong', nowMs: 100,
    intent: { state: 'ready', anidbId: 42, kind: 'series', monitorFuture: false,
      episodeIds: [1001] } });
  const acquisitions = openAcquisitionLedger(dbPath);
  const torrentHash = 'a'.repeat(40);
  const candidate = { indexerId: 7, guid: 'wrong-release' };
  const claim = acquisitions.reserve({ requestId: saved.requestId, candidate,
    episodeIds: [1001], nowMs: 200 });
  acquisitions.bindPreparedTorrent({ attemptId: claim.attemptId, candidate,
    hash: torrentHash, nowMs: 201 });
  acquisitions.recordFilePlan({ attemptId: claim.attemptId, hash: torrentHash,
    plannedFiles: [{ name: '01.mkv', size: 1000, episodeIds: [1001] }], nowMs: 202 });
  acquisitions.beginDispatch({ attemptId: claim.attemptId, nowMs: 203 });
  acquisitions.recordTorrent({ attemptId: claim.attemptId, hash: torrentHash, nowMs: 204 });
  acquisitions.beginStart({ attemptId: claim.attemptId, hash: torrentHash,
    manifestDigest: 'b'.repeat(64), nowMs: 205 });
  const handoffs = openHandoffLedger(dbPath);
  const { mkdir } = await import('node:fs/promises');
  const [stagingHostPath, holdingRoot, importRoot] = ['staging', 'holding', 'import']
    .map((name) => path.join(root, name));
  await Promise.all([stagingHostPath, holdingRoot, importRoot].map((dir) => mkdir(dir)));
  const base = { requests, acquisitions, handoffs, attemptId: claim.attemptId,
    stagingHostPath, holdingRoot, importRoot, nowMs: 206,
    observe: async () => ({ state: 'complete', files: [
      { index: 0, name: '01.mkv', size: 1000 }], subtitles: [] }),
    lookup: async () => null };
  try {
    assert.deepEqual(await prepareRecordedHandoff({ ...base,
      verify: async () => ({ state: 'held', reason: 'provider_unavailable' }) }),
    { state: 'held', reason: 'file_provider_unavailable' });
    assert.equal(acquisitions.getAttempt(claim.attemptId).status, 'torrent_observed');
    assert.deepEqual(await prepareRecordedHandoff({ ...base,
      verify: async () => ({ state: 'rejected', reason: 'wrong_identity' }) }),
    { state: 'rejected_held', reason: 'file_wrong_identity' });
    assert.equal(acquisitions.getAttempt(claim.attemptId).status, 'rejected_held');
    assert.equal(handoffs.getHandoff(claim.attemptId), null);
    const details = { anidbId: 42, torrentHash,
      files: [{ name: '01.mkv', size: 1000, ed2k: 'A'.repeat(32),
        anidbFileId: 51, episodeIds: [1001] }], subtitles: [] };
    assert.deepEqual(handoffs.recordPrepared({ attemptId: claim.attemptId,
      prepared: { state: 'handoff_prepared', publishReady: false,
        holdingPath: path.join(holdingRoot, '.negev-prep-fake'),
        evidenceDigest: evaluateHandoffEvidence(details).digest, ...details },
      nowMs: 207 }),
    { state: 'held', reason: 'candidate_rejected' });
    assert.deepEqual(await readdir(holdingRoot), []);
  } finally {
    handoffs.close(); acquisitions.close(); requests.close();
    await rm(root, { recursive: true, force: true });
  }
});
