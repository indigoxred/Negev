import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { openAcquisitionLedger } from '../src/acquisition/acquisition-ledger.mjs';
import { openHandoffLedger } from '../src/acquisition/handoff-ledger.mjs';
import { evaluateHandoffEvidence } from '../src/acquisition/handoff-evidence.mjs';
import { openHandoffPublishQueue, createHandoffPublishWorker } from
  '../src/acquisition/handoff-publish-queue.mjs';

async function fixture(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-publish-queue-'));
  const dbPath = path.join(root, 'state.sqlite');
  const requests = openRequestLedger(dbPath);
  const request = requests.submit({ requesterId: 1, requestKey: 'batch', nowMs: 100,
    intent: { state: 'ready', anidbId: 42, kind: 'series',
      monitorFuture: false, episodeIds: [1001, 1002, 1003] } });
  const acquisitions = openAcquisitionLedger(dbPath);
  const handoffs = openHandoffLedger(dbPath);
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const candidate = { indexerId: 7, guid: `publish-${i}` };
    const hash = String(i + 1).repeat(40);
    const reserved = acquisitions.reserve({ requestId: request.requestId, candidate,
      episodeIds: [1001 + i], nowMs: 200 + i * 10 });
    const attemptId = reserved.attemptId;
    acquisitions.bindPreparedTorrent({ attemptId, candidate, hash,
      nowMs: 201 + i * 10 });
    acquisitions.recordFilePlan({ attemptId, hash,
      plannedFiles: [{ name: `${i + 1}.mkv`, size: 10,
        episodeIds: [1001 + i] }], nowMs: 202 + i * 10 });
    acquisitions.beginDispatch({ attemptId, nowMs: 203 + i * 10 });
    acquisitions.recordTorrent({ attemptId, hash, nowMs: 204 + i * 10 });
    acquisitions.beginStart({ attemptId, hash,
      manifestDigest: 'b'.repeat(64), nowMs: 205 + i * 10 });
    const batch = { anidbId: 42, torrentHash: hash,
      files: [{ name: `${i + 1}.mkv`, size: 10, ed2k: 'A'.repeat(32),
        anidbFileId: 51 + i, episodeIds: [1001 + i] }], subtitles: [] };
    assert.equal(handoffs.recordPrepared({ attemptId,
      prepared: { ...batch, state: 'handoff_prepared', publishReady: false,
        holdingPath: path.join(root, `holding-${i}`),
        evidenceDigest: evaluateHandoffEvidence(batch).digest },
      nowMs: 206 + i * 10 }).state, 'prepared');
    ids.push(attemptId);
  }
  let queue = openHandoffPublishQueue(dbPath);
  try {
    await run({ dbPath, ids, handoffs,
      get queue() { return queue; },
      reopen() { queue.close(); queue = openHandoffPublishQueue(dbPath); } });
  } finally {
    queue.close(); handoffs.close(); acquisitions.close(); requests.close();
    await rm(root, { recursive: true, force: true });
  }
}

test('one held handoff defers while later prepared batches continue', async () =>
  fixture(async (ctx) => {
    const seen = [];
    const worker = createHandoffPublishWorker({ queue: ctx.queue,
      now: () => 1_000, processAttempt: async ({ attemptId }) => {
        seen.push(attemptId);
        return { state: 'held', reason: 'identity_unavailable' };
      } });
    assert.equal((await worker.runOnce()).attemptId, ctx.ids[0]);
    assert.equal(ctx.queue.getResult(ctx.ids[0]).nextDueMs, 1_801_000);
    assert.equal((await worker.runOnce()).attemptId, ctx.ids[1]);
    assert.equal((await worker.runOnce()).attemptId, ctx.ids[2]);
    assert.deepEqual(await worker.runOnce(), { state: 'idle' });
    assert.deepEqual(seen, ctx.ids);
    ctx.reopen();
    assert.equal(ctx.queue.claimNext({ nowMs: 1_800_999 }).state, 'idle');
    assert.equal(ctx.queue.claimNext({ nowMs: 1_801_000 }).attemptId, ctx.ids[0]);
  }));

test('changed evidence requires review and does not repeatedly hash the same batch', async () =>
  fixture(async (ctx) => {
    const first = ctx.queue.claimNext({ nowMs: 1_000 });
    assert.deepEqual(ctx.queue.recordResult({ attemptId: first.attemptId,
      version: first.version, state: 'held', reason: 'manifest_tree_mismatch',
      checkedMs: 1_001 }), { state: 'recorded' });
    assert.equal(ctx.queue.getResult(first.attemptId).nextDueMs, null);
    assert.deepEqual(ctx.queue.listReviewNeeded(), [{ attemptId: first.attemptId,
      reason: 'manifest_tree_mismatch', checkedMs: 1_001 }]);
    ctx.reopen();
    assert.equal(ctx.queue.listReviewNeeded().length, 1);
    assert.equal(ctx.queue.claimNext({ nowMs: 10_000_000 }).attemptId, ctx.ids[1]);
  }));

test('temporary provider failure gets at most one automatic retry', async () =>
  fixture(async (ctx) => {
    const first = ctx.queue.claimNext({ nowMs: 1_000 });
    assert.equal(ctx.queue.recordResult({ attemptId: first.attemptId,
      version: first.version, state: 'held', reason: 'identity_unavailable',
      checkedMs: 1_001 }).state, 'recorded');
    const second = ctx.queue.claimNext({ nowMs: 1_801_001 });
    assert.equal(second.attemptId, first.attemptId);
    assert.equal(ctx.queue.recordResult({ attemptId: second.attemptId,
      version: second.version, state: 'held', reason: 'identity_unavailable',
      checkedMs: 1_801_002 }).state, 'recorded');
    assert.equal(ctx.queue.getResult(first.attemptId).nextDueMs, null);
    assert.equal(ctx.queue.claimNext({ nowMs: 10_000_000 }).attemptId, ctx.ids[1]);
  }));

test('unknown publish outcome requires review after one reconciliation', async () =>
  fixture(async (ctx) => {
    const first = ctx.queue.claimNext({ nowMs: 1_000 });
    const row = ctx.handoffs.getHandoff(first.attemptId);
    assert.equal(ctx.handoffs.beginPublish({ attemptId: first.attemptId,
      evidenceDigest: row.evidenceDigest, nowMs: 1_001 }).state, 'publish_unknown');
    assert.equal(ctx.queue.recordResult({ attemptId: first.attemptId,
      version: first.version, state: 'publish_unknown', checkedMs: 1_002 }).state,
    'recorded');
    const second = ctx.queue.claimNext({ nowMs: 61_002 });
    assert.equal(second.attemptId, first.attemptId);
    assert.equal(ctx.queue.recordResult({ attemptId: second.attemptId,
      version: second.version, state: 'held', reason: 'publish_outcome_unknown',
      checkedMs: 61_003 }).state, 'recorded');
    assert.equal(ctx.queue.getResult(first.attemptId).nextDueMs, null);
    assert.equal(ctx.queue.claimNext({ nowMs: 10_000_000 }).attemptId, ctx.ids[1]);
  }));

test('an interrupted claim resumes from durable publish intent without a second send', async () =>
  fixture(async (ctx) => {
    const claim = ctx.queue.claimNext({ nowMs: 1_000 });
    const row = ctx.handoffs.getHandoff(claim.attemptId);
    assert.equal(ctx.handoffs.beginPublish({ attemptId: claim.attemptId,
      evidenceDigest: row.evidenceDigest, nowMs: 1_001 }).state, 'publish_unknown');
    ctx.reopen();
    assert.deepEqual(ctx.queue.reconcileUnresolved({ nowMs: 1_002 }),
      { state: 'reviewed', resolved: [claim.attemptId], held: [] });
    assert.equal(ctx.queue.getResult(claim.attemptId).state, 'publish_unknown');
    assert.equal(ctx.queue.claimNext({ nowMs: 1_002 }).attemptId, claim.attemptId);
  }));

test('an interrupted pre-intent claim waits while another handoff advances', async () =>
  fixture(async (ctx) => {
    const claim = ctx.queue.claimNext({ nowMs: 1_000 });
    ctx.reopen();
    assert.deepEqual(ctx.queue.reconcileUnresolved({ nowMs: 1_001 }),
      { state: 'reviewed', resolved: [claim.attemptId], held: [] });
    assert.equal(ctx.queue.getResult(claim.attemptId).state, 'held');
    assert.equal(ctx.queue.claimNext({ nowMs: 1_001 }).attemptId, ctx.ids[1]);
    assert.equal(ctx.queue.getResult(claim.attemptId).nextDueMs, 301_001);
  }));

test('a worker cannot record publication without the matching journal state', async () =>
  fixture(async (ctx) => {
    const claim = ctx.queue.claimNext({ nowMs: 1_000 });
    assert.deepEqual(ctx.queue.recordResult({ attemptId: claim.attemptId,
      version: claim.version, state: 'published_observed', checkedMs: 1_001 }),
    { state: 'held', reason: 'outcome_changed' });
    assert.equal(ctx.queue.getResult(claim.attemptId).state, null);
  }));

test('two queue connections cannot claim the same prepared handoff', async () =>
  fixture(async (ctx) => {
    const other = openHandoffPublishQueue(ctx.dbPath);
    try {
      const first = ctx.queue.claimNext({ nowMs: 1_000 });
      const second = other.claimNext({ nowMs: 1_000 });
      assert.equal(first.attemptId, ctx.ids[0]);
      assert.equal(second.attemptId, ctx.ids[1]);
    } finally { other.close(); }
  }));
