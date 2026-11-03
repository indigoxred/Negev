import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { openAcquisitionLedger } from '../src/acquisition/acquisition-ledger.mjs';
import { openHandoffLedger } from '../src/acquisition/handoff-ledger.mjs';
import { openCompletionQueue, createCompletionWorker } from '../src/acquisition/completion-queue.mjs';
import { evaluateHandoffEvidence } from '../src/acquisition/handoff-evidence.mjs';

async function fixture(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-completion-queue-'));
  const dbPath = path.join(root, 'state.sqlite');
  const requests = openRequestLedger(dbPath);
  const request = requests.submit({ requesterId: 1, requestKey: 'series', nowMs: 100,
    intent: { state: 'ready', anidbId: 42, kind: 'series', monitorFuture: false,
      episodeIds: [1001, 1002, 1003] } });
  const acquisitions = openAcquisitionLedger(dbPath);
  const attemptIds = [];
  const hashes = [];
  for (let i = 0; i < 3; i++) {
    const candidate = { indexerId: 7, guid: `release-${i}` };
    const hash = String(i + 1).repeat(40);
    const reserved = acquisitions.reserve({ requestId: request.requestId, candidate,
      episodeIds: [1001 + i], nowMs: 200 + i * 10 });
    acquisitions.bindPreparedTorrent({ attemptId: reserved.attemptId, candidate,
      hash, nowMs: 201 + i * 10 });
    acquisitions.recordFilePlan({ attemptId: reserved.attemptId, hash,
      plannedFiles: [{ name: `${i + 1}.mkv`, size: 10, episodeIds: [1001 + i] }],
      nowMs: 202 + i * 10 });
    acquisitions.beginDispatch({ attemptId: reserved.attemptId, nowMs: 203 + i * 10 });
    acquisitions.recordTorrent({ attemptId: reserved.attemptId, hash,
      nowMs: 204 + i * 10 });
    acquisitions.beginStart({ attemptId: reserved.attemptId, hash,
      manifestDigest: 'b'.repeat(64), nowMs: 205 + i * 10 });
    attemptIds.push(reserved.attemptId);
    hashes.push(hash);
  }
  const handoffs = openHandoffLedger(dbPath);
  let queue = openCompletionQueue(dbPath);
  try {
    await run({ root, dbPath, requests, acquisitions, handoffs, attemptIds, hashes,
      get queue() { return queue; }, reopen() { queue.close(); queue = openCompletionQueue(dbPath); } });
  } finally {
    queue.close(); handoffs.close(); acquisitions.close(); requests.close();
    await rm(root, { recursive: true, force: true });
  }
}

test('one-attempt pages advance after incomplete work and retry only when due', async () => {
  await fixture(async (ctx) => {
    const worker = createCompletionWorker({ queue: ctx.queue, now: () => 1_000,
      processAttempt: async ({ attemptId }) => {
        assert.equal(attemptId, ctx.attemptIds[0]);
        return { state: 'held', reason: 'incomplete' };
      } });
    assert.deepEqual(await worker.runOnce(), { state: 'processed',
      attemptId: ctx.attemptIds[0], result: { state: 'held', reason: 'incomplete' } });
    assert.equal(ctx.queue.getResult(ctx.attemptIds[0]).nextDueMs, 301_000);
    const next = ctx.queue.claimNext({ nowMs: 1_000 });
    assert.deepEqual(next, { state: 'claimed', attemptId: ctx.attemptIds[1], pass: 1 });
    assert.equal(ctx.queue.claimNext({ nowMs: 1_000 }).attemptId, ctx.attemptIds[2]);
    assert.deepEqual(ctx.queue.claimNext({ nowMs: 1_000 }),
      { state: 'pass_complete', pass: 1 });
    assert.deepEqual(ctx.queue.claimNext({ nowMs: 300_999 }),
      { state: 'pass_complete', pass: 2 });
    assert.deepEqual(ctx.queue.claimNext({ nowMs: 301_000 }),
      { state: 'claimed', attemptId: ctx.attemptIds[0], pass: 3 });
  });
});

test('a retirement intent excludes completion while unrelated attempts advance', async () => {
  await fixture(async (ctx) => {
    assert.deepEqual(ctx.acquisitions.requestStalledRetirement({
      attemptId: ctx.attemptIds[0], hash: ctx.hashes[0], nowMs: 300 }),
    { state: 'retirement_requested' });
    assert.equal(ctx.queue.claimNext({ nowMs: 1_000 }).attemptId,
      ctx.attemptIds[1]);
    assert.equal(ctx.queue.claimNext({ nowMs: 1_000 }).attemptId,
      ctx.attemptIds[2]);
  });
});

test('unfinished claim survives restart and does not stall a later attempt', async () => {
  await fixture(async (ctx) => {
    const first = ctx.queue.claimNext({ nowMs: 1_000 });
    ctx.reopen();
    assert.equal(ctx.queue.claimNext({ nowMs: 1_001 }).attemptId, ctx.attemptIds[1]);
    assert.deepEqual(ctx.queue.listReviewNeeded({ nowMs: 1_001 }), [
      { attemptId: ctx.attemptIds[0], reason: 'completion_interrupted',
        observedMs: 1_001 },
      { attemptId: ctx.attemptIds[1], reason: 'completion_interrupted',
        observedMs: 1_001 },
    ]);
    assert.deepEqual(ctx.queue.reconcileUnresolved({ nowMs: 1_002 }),
      { state: 'reviewed', resolved: [], held: [ctx.attemptIds[0], ctx.attemptIds[1]] });
    assert.equal(ctx.queue.recordResult({ attemptId: first.attemptId, pass: first.pass,
      state: 'held', reason: 'provider_unavailable', checkedMs: 1_003 }).state,
    'recorded');
    assert.deepEqual(ctx.queue.listReviewNeeded({ nowMs: 1_004 }), [
      { attemptId: ctx.attemptIds[1], reason: 'completion_interrupted',
        observedMs: 1_004 },
    ]);
  });
});

test('completion recovery reviews every page of interrupted attempts', async () => {
  await fixture(async (ctx) => {
    for (const attemptId of ctx.attemptIds) {
      assert.equal(ctx.queue.claimNext({ nowMs: 1_000 }).attemptId, attemptId);
    }
    ctx.reopen();
    assert.deepEqual(ctx.queue.reconcileUnresolved({ nowMs: 1_001, limit: 1 }),
      { state: 'reviewed', resolved: [], held: ctx.attemptIds });
  });
});

test('restart reconciliation accepts durable handoff or rejection evidence only', async () => {
  await fixture(async (ctx) => {
    const first = ctx.queue.claimNext({ nowMs: 1_000 });
    const manifest = { anidbId: 42, torrentHash: ctx.hashes[0],
      files: [{ name: '1.mkv', size: 10, ed2k: 'A'.repeat(32),
        anidbFileId: 51, episodeIds: [1001] }], subtitles: [] };
    const digest = evaluateHandoffEvidence(manifest).digest;
    assert.equal(ctx.handoffs.recordPrepared({ attemptId: first.attemptId,
      prepared: { ...manifest, state: 'handoff_prepared', publishReady: false,
        holdingPath: path.join(ctx.root, 'private-holding'), evidenceDigest: digest },
      nowMs: 1_001 }).state, 'prepared');
    const second = ctx.queue.claimNext({ nowMs: 1_002 });
    assert.equal(ctx.acquisitions.recordTerminalRejection({ attemptId: second.attemptId,
      hash: ctx.hashes[1], reason: 'file_wrong_identity', nowMs: 1_003 }).state,
    'rejected_held');
    assert.deepEqual(ctx.queue.listReviewNeeded({ nowMs: 1_003 }), []);
    ctx.reopen();
    assert.deepEqual(ctx.queue.reconcileUnresolved({ nowMs: 1_004 }),
      { state: 'reviewed', resolved: [ctx.attemptIds[0], ctx.attemptIds[1]], held: [] });
    assert.equal(ctx.queue.getResult(first.attemptId).state, 'handoff_prepared');
    assert.equal(ctx.queue.getResult(second.attemptId).state, 'rejected_held');
    assert.equal(ctx.queue.claimNext({ nowMs: 1_005 }).attemptId, ctx.attemptIds[2]);
  });
});

test('two queue connections cannot claim the same completed attempt', async () => {
  await fixture(async (ctx) => {
    const second = openCompletionQueue(ctx.dbPath);
    try {
      const a = ctx.queue.claimNext({ nowMs: 1_000 });
      const b = second.claimNext({ nowMs: 1_000 });
      assert.equal(a.attemptId, ctx.attemptIds[0]);
      assert.equal(b.attemptId, ctx.attemptIds[1]);
      assert.notEqual(a.attemptId, b.attemptId);
    } finally { second.close(); }
  });
});
