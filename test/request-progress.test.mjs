import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { openAcquisitionLedger } from '../src/acquisition/acquisition-ledger.mjs';
import { openCompletionQueue } from '../src/acquisition/completion-queue.mjs';
import { openHandoffLedger } from '../src/acquisition/handoff-ledger.mjs';
import { openAcquisitionRequestQueue,
  reconcileUnresolvedAcquisitionClaims } from '../src/acquisition/acquisition-request-queue.mjs';
import { evaluateHandoffEvidence } from '../src/acquisition/handoff-evidence.mjs';
import { openRequestProgress } from '../src/requests/request-progress.mjs';

test('an unstarted cutover hold is visible even when the queue opens after progress',
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'negev-cutover-progress-'));
    const dbPath = path.join(root, 'state.sqlite');
    const requests = openRequestLedger(dbPath);
    const saved = requests.submit({ requesterId: 1, requestKey: 'cutover',
      nowMs: 100, intent: { state: 'ready', anidbId: 42,
        kind: 'series', monitorFuture: false, episodeIds: [1001] } });
    const acquisitions = openAcquisitionLedger(dbPath);
    const handoffs = openHandoffLedger(dbPath);
    const progress = openRequestProgress(dbPath);
    const queue = openAcquisitionRequestQueue(dbPath);
    try {
      queue.suspendUnstarted({ requestId: saved.requestId,
        reason: 'cutover_review', nowMs: 101 });
      assert.deepEqual(progress.read(saved.requestId), {
        state: 'owner_review_pending', targetCount: 1,
        privateVerifiedTargets: 0, activeAttempts: 0,
        reviewRequired: true, publicAvailability: 'unverified' });
      queue.resumeSuspended({ requestId: saved.requestId });
      assert.equal(progress.read(saved.requestId).state, 'saved');
    } finally { queue.close(); progress.close(); handoffs.close();
      acquisitions.close(); requests.close();
      await rm(root, { recursive: true, force: true }); }
  });

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
    const completion = openCompletionQueue(dbPath);
    try {
      const check = completion.claimNext({ nowMs: 205 });
      assert.equal(check.attemptId, claim.attemptId);
      completion.recordResult({ attemptId: claim.attemptId, pass: check.pass,
        state: 'held', reason: 'file_lookup_inconclusive', checkedMs: 206 });
      assert.deepEqual(progress.read(saved.requestId), {
        state: 'release_identity_unverified', targetCount: 2,
        privateVerifiedTargets: 0, activeAttempts: 1,
        reviewRequired: false, publicAvailability: 'unverified' });
    } finally { completion.close(); }
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
    const secondCandidate = { indexerId: 7, guid: 'second' };
    const secondHash = 'c'.repeat(40);
    const second = acquisitions.reserve({ requestId: saved.requestId,
      candidate: secondCandidate, episodeIds: [1002], nowMs: 207 });
    acquisitions.bindPreparedTorrent({ attemptId: second.attemptId,
      candidate: secondCandidate, hash: secondHash, nowMs: 208 });
    acquisitions.recordFilePlan({ attemptId: second.attemptId, hash: secondHash,
      plannedFiles: [{ name: '02.mkv', size: 10, episodeIds: [1002] }], nowMs: 209 });
    acquisitions.beginDispatch({ attemptId: second.attemptId, nowMs: 210 });
    acquisitions.recordTorrent({ attemptId: second.attemptId, hash: secondHash, nowMs: 211 });
    acquisitions.beginStart({ attemptId: second.attemptId, hash: secondHash,
      manifestDigest: 'd'.repeat(64), nowMs: 212 });
    const secondCompletion = openCompletionQueue(dbPath);
    try {
      const check = secondCompletion.claimNext({ nowMs: 213 });
      assert.equal(check.attemptId, second.attemptId);
      secondCompletion.recordResult({ attemptId: second.attemptId,
        pass: check.pass, state: 'held', reason: 'file_lookup_inconclusive',
        checkedMs: 214 });
      assert.deepEqual(progress.read(saved.requestId), {
        state: 'partial_private_copy', targetCount: 2,
        privateVerifiedTargets: 1, activeAttempts: 2,
        reviewRequired: false, publicAvailability: 'unverified',
        identityCheckPending: true });
      assert.equal(acquisitions.requestStalledRetirement({
        attemptId: second.attemptId, hash: secondHash, nowMs: 215 }).state,
      'retirement_requested');
      assert.deepEqual(progress.read(saved.requestId), {
        state: 'partial_private_copy', targetCount: 2,
        privateVerifiedTargets: 1, activeAttempts: 2,
        reviewRequired: false, publicAvailability: 'unverified',
        identityRetirementPending: true });
    } finally { secondCompletion.close(); }
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

test('a held stopped-add check is shown as scheduled for retry', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-retry-progress-'));
  const dbPath = path.join(root, 'state.sqlite');
  const requests = openRequestLedger(dbPath);
  const saved = requests.submit({ requesterId: 1, requestKey: 'retry', nowMs: 100,
    intent: { state: 'ready', anidbId: 42, kind: 'movie',
      monitorFuture: false, episodeIds: [1001] } });
  const acquisitions = openAcquisitionLedger(dbPath);
  const handoffs = openHandoffLedger(dbPath);
  const progress = openRequestProgress(dbPath);
  const queue = openAcquisitionRequestQueue(dbPath);
  try {
    const queued = queue.claimNext({ nowMs: 200 });
    const candidate = { indexerId: 7, guid: 'settling-release' };
    const claim = acquisitions.reserve({ requestId: saved.requestId,
      candidate, episodeIds: [1001], nowMs: 201 });
    acquisitions.bindPreparedTorrent({ attemptId: claim.attemptId,
      candidate, hash: 'a'.repeat(40), nowMs: 202 });
    acquisitions.beginDispatch({ attemptId: claim.attemptId, nowMs: 203 });
    queue.recordResult({ requestId: saved.requestId, pass: queued.pass,
      state: 'held', reason: 'not_pristine_stopped', checkedMs: 204 });
    assert.deepEqual(progress.read(saved.requestId), {
      state: 'release_check_retrying', targetCount: 1,
      privateVerifiedTargets: 0, activeAttempts: 1,
      reviewRequired: false, publicAvailability: 'unverified' });
  } finally { queue.close(); progress.close(); handoffs.close();
    acquisitions.close(); requests.close();
    await rm(root, { recursive: true, force: true }); }
});
