import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { openAcquisitionLedger } from '../src/acquisition/acquisition-ledger.mjs';
import { openHandoffLedger } from '../src/acquisition/handoff-ledger.mjs';
import { openAcquisitionRequestQueue,
  reconcileUnresolvedAcquisitionClaims } from '../src/acquisition/acquisition-request-queue.mjs';
import { evaluateHandoffEvidence } from '../src/acquisition/handoff-evidence.mjs';
import { openRequestProgress } from '../src/requests/request-progress.mjs';

test('request progress distinguishes private proof from public availability', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-progress-'));
  const dbPath = path.join(root, 'state.sqlite');
  const requests = openRequestLedger(dbPath);
  const saved = requests.submit({ requesterId: 1, requestKey: 'series', nowMs: 100,
    intent: { state: 'ready', anidbId: 42, kind: 'series', monitorFuture: false,
      episodeIds: [1001, 1002] } });
  const acquisitions = openAcquisitionLedger(dbPath);
  const handoffs = openHandoffLedger(dbPath);
  const progress = openRequestProgress(dbPath);
  try {
    assert.deepEqual(progress.read(saved.requestId), { state: 'saved',
      targetCount: 2, privateVerifiedTargets: 0, activeAttempts: 0,
      reviewRequired: false, publicAvailability: 'unverified' });
    const candidate = { indexerId: 7, guid: 'first' };
    const hash = 'a'.repeat(40);
    const claim = acquisitions.reserve({ requestId: saved.requestId, candidate,
      episodeIds: [1001], nowMs: 200 });
    acquisitions.bindPreparedTorrent({ attemptId: claim.attemptId, candidate,
      hash, nowMs: 201 });
    acquisitions.recordFilePlan({ attemptId: claim.attemptId, hash,
      plannedFiles: [{ name: '01.mkv', size: 10, episodeIds: [1001] }], nowMs: 202 });
    acquisitions.beginDispatch({ attemptId: claim.attemptId, nowMs: 203 });
    acquisitions.recordTorrent({ attemptId: claim.attemptId, hash, nowMs: 204 });
    acquisitions.beginStart({ attemptId: claim.attemptId, hash,
      manifestDigest: 'b'.repeat(64), nowMs: 205 });
    assert.deepEqual(progress.read(saved.requestId), { state: 'download_unverified',
      targetCount: 2, privateVerifiedTargets: 0, activeAttempts: 1,
      reviewRequired: false, publicAvailability: 'unverified' });
    const manifest = { anidbId: 42, torrentHash: hash,
      files: [{ name: '01.mkv', size: 10, ed2k: 'A'.repeat(32),
        anidbFileId: 51, episodeIds: [1001] }], subtitles: [] };
    handoffs.recordPrepared({ attemptId: claim.attemptId,
      prepared: { ...manifest, state: 'handoff_prepared', publishReady: false,
        holdingPath: path.join(root, 'holding'),
        evidenceDigest: evaluateHandoffEvidence(manifest).digest }, nowMs: 206 });
    assert.deepEqual(progress.read(saved.requestId), { state: 'partial_private_copy',
      targetCount: 2, privateVerifiedTargets: 1, activeAttempts: 1,
      reviewRequired: false, publicAvailability: 'unverified' });
    assert.equal(progress.read(999), null);
  } finally {
    progress.close(); handoffs.close(); acquisitions.close(); requests.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a future-only Airing watch has readable zero-target progress', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-future-progress-'));
  const dbPath = path.join(root, 'state.sqlite');
  const requests = openRequestLedger(dbPath);
  const saved = requests.submit({ requesterId: 1, requestKey: 'future', nowMs: 100,
    intent: { state: 'ready', anidbId: 42, kind: 'series',
      monitorFuture: true, episodeIds: [] } });
  const acquisitions = openAcquisitionLedger(dbPath);
  const handoffs = openHandoffLedger(dbPath);
  const progress = openRequestProgress(dbPath);
  try {
    assert.deepEqual(progress.read(saved.requestId), { state: 'saved',
      targetCount: 0, privateVerifiedTargets: 0, activeAttempts: 0,
      reviewRequired: false, publicAvailability: 'unverified' });
  } finally { progress.close(); handoffs.close(); acquisitions.close();
    requests.close(); await rm(root, { recursive: true, force: true }); }
});

test('one-time completion remains visible after its recent Plex proof expires', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-completed-progress-'));
  const dbPath = path.join(root, 'state.sqlite');
  const requests = openRequestLedger(dbPath);
  const saved = requests.submit({ requesterId: 1, requestKey: 'complete', nowMs: 100,
    intent: { state: 'ready', anidbId: 42, kind: 'series',
      monitorFuture: false, episodeIds: [1001] } });
  const airing = requests.submit({ requesterId: 1, requestKey: 'airing', nowMs: 101,
    intent: { state: 'ready', anidbId: 43, kind: 'series',
      monitorFuture: true, episodeIds: [2001] } });
  const acquisitions = openAcquisitionLedger(dbPath);
  const handoffs = openHandoffLedger(dbPath);
  // The account service opens progress before the opt-in acquisition queue.
  const progress = openRequestProgress(dbPath);
  const queue = openAcquisitionRequestQueue(dbPath);
  try {
    const claim = queue.claimNext({ nowMs: 200 });
    assert.equal(claim.requestId, saved.requestId);
    queue.recordResult({ requestId: saved.requestId, pass: claim.pass,
      state: 'held', reason: 'request_fully_available', checkedMs: 201 });
    const airingClaim = queue.claimNext({ nowMs: 202 });
    queue.recordResult({ requestId: airing.requestId, pass: airingClaim.pass,
      state: 'held', reason: 'request_fully_available', checkedMs: 203 });
    assert.deepEqual(progress.read(saved.requestId), { state: 'saved',
      targetCount: 1, privateVerifiedTargets: 0, activeAttempts: 0,
      reviewRequired: false, publicAvailability: 'unverified',
      oneTimeAcquisitionComplete: true });
    assert.deepEqual(progress.read(airing.requestId), { state: 'saved',
      targetCount: 1, privateVerifiedTargets: 0, activeAttempts: 0,
      reviewRequired: false, publicAvailability: 'unverified' });
  } finally { queue.close(); progress.close(); handoffs.close();
    acquisitions.close(); requests.close();
    await rm(root, { recursive: true, force: true }); }
});

test('an interrupted request with a prior attempt is shown as needing review', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-interrupted-progress-'));
  const dbPath = path.join(root, 'state.sqlite');
  const requests = openRequestLedger(dbPath);
  const saved = requests.submit({ requesterId: 1, requestKey: 'airing-interrupted',
    nowMs: 100, intent: { state: 'ready', anidbId: 42, kind: 'series',
      monitorFuture: true, episodeIds: [1001] } });
  const acquisitions = openAcquisitionLedger(dbPath);
  const handoffs = openHandoffLedger(dbPath);
  const queue = openAcquisitionRequestQueue(dbPath);
  const progress = openRequestProgress(dbPath);
  try {
    acquisitions.reserve({ requestId: saved.requestId,
      candidate: { indexerId: 7, guid: 'earlier-episode' },
      episodeIds: [1001], nowMs: 101 });
    const claim = queue.claimNext({ nowMs: 200 });
    assert.equal(claim.requestId, saved.requestId);
    assert.deepEqual(await reconcileUnresolvedAcquisitionClaims({ queue,
      inspectRequest: (requestId) => acquisitions.inspectRequestAttempts(requestId),
      now: () => 201 }), { state: 'reviewed',
      resolved: [saved.requestId], held: [] });
    assert.deepEqual(progress.read(saved.requestId), {
      state: 'request_interrupted', targetCount: 1,
      privateVerifiedTargets: 0, activeAttempts: 1,
      reviewRequired: true, publicAvailability: 'unverified' });
  } finally { progress.close(); queue.close(); handoffs.close();
    acquisitions.close(); requests.close();
    await rm(root, { recursive: true, force: true }); }
});
