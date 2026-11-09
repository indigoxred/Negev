import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { openAcquisitionLedger } from '../src/acquisition/acquisition-ledger.mjs';
import { openAcquisitionRequestQueue } from '../src/acquisition/acquisition-request-queue.mjs';
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
    await run({ dbPath, ids, requests, acquisitions, handoffs,
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

test('cutover hold excludes prepared handoffs across reopen until resumed',
  async () => fixture(async (ctx) => {
    const later = ctx.requests.submit({ requesterId: 1,
      requestKey: 'later-publish', nowMs: 800,
      intent: { state: 'ready', anidbId: 43, kind: 'series',
        monitorFuture: false, episodeIds: [2001] } });
    const candidate = { indexerId: 7, guid: 'later-publish' };
    const hash = 'f'.repeat(40);
    const laterId = ctx.acquisitions.reserve({ requestId: later.requestId,
      candidate, episodeIds: [2001], nowMs: 801 }).attemptId;
    ctx.acquisitions.bindPreparedTorrent({ attemptId: laterId,
      candidate, hash, nowMs: 802 });
    ctx.acquisitions.recordFilePlan({ attemptId: laterId, hash,
      plannedFiles: [{ name: 'later.mkv', size: 10,
        episodeIds: [2001] }], nowMs: 803 });
    ctx.acquisitions.beginDispatch({ attemptId: laterId, nowMs: 804 });
    ctx.acquisitions.recordTorrent({ attemptId: laterId, hash, nowMs: 805 });
    ctx.acquisitions.beginStart({ attemptId: laterId, hash,
      manifestDigest: 'b'.repeat(64), nowMs: 806 });
    const batch = { anidbId: 43, torrentHash: hash,
      files: [{ name: 'later.mkv', size: 10, ed2k: 'A'.repeat(32),
        anidbFileId: 99, episodeIds: [2001] }], subtitles: [] };
    assert.equal(ctx.handoffs.recordPrepared({ attemptId: laterId,
      prepared: { ...batch, state: 'handoff_prepared', publishReady: false,
        holdingPath: path.join(path.dirname(ctx.dbPath), 'later-holding'),
        evidenceDigest: evaluateHandoffEvidence(batch).digest },
      nowMs: 807 }).state, 'prepared');
    const holds = openAcquisitionRequestQueue(ctx.dbPath);
    try {
      assert.deepEqual(holds.suspendForCutover({ requestId: 1,
        reason: 'cutover_review', nowMs: 900 }), { state: 'suspended' });
      assert.equal(ctx.queue.claimNext({ nowMs: 1_000 }).attemptId, laterId);
      assert.equal(ctx.queue.claimNext({ nowMs: 1_000 }).state, 'idle');
      ctx.reopen();
      assert.equal(ctx.queue.claimNext({ nowMs: 1_001 }).state, 'idle');
      assert.deepEqual(holds.resumeSuspended({ requestId: 1 }),
        { state: 'resumed' });
      assert.equal(ctx.queue.claimNext({ nowMs: 1_002 }).attemptId,
        ctx.ids[0]);
    } finally { holds.close(); }
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

test('missing preflight mount keeps a paced retry while later batches advance', async () =>
  fixture(async (ctx) => {
    const first = ctx.queue.claimNext({ nowMs: 1_000 });
    assert.equal(ctx.queue.recordResult({ attemptId: first.attemptId,
      version: first.version, state: 'held', reason: 'handoff_mount_unavailable',
      checkedMs: 1_001 }).state, 'recorded');
    assert.equal(ctx.queue.getResult(first.attemptId).nextDueMs, 301_001);
    assert.equal(ctx.queue.claimNext({ nowMs: 1_002 }).attemptId, ctx.ids[1]);
    ctx.reopen();
    const retry = ctx.queue.claimNext({ nowMs: 301_001 });
    assert.equal(retry.attemptId, first.attemptId);
    assert.equal(ctx.queue.recordResult({ attemptId: retry.attemptId,
      version: retry.version, state: 'held', reason: 'handoff_mount_unavailable',
      checkedMs: 301_002 }).state, 'recorded');
    assert.equal(ctx.queue.getResult(first.attemptId).nextDueMs, 601_002,
      'a preflight mount check can continue without hashing the batch');
  }));

test('mount loss after file verification requires review rather than repeated reads', async () =>
  fixture(async (ctx) => {
    const claim = ctx.queue.claimNext({ nowMs: 1_000 });
    assert.equal(ctx.queue.recordResult({ attemptId: claim.attemptId,
      version: claim.version, state: 'held',
      reason: 'handoff_mount_unavailable_after_verify',
      checkedMs: 1_001 }).state, 'recorded');
    assert.equal(ctx.queue.getResult(claim.attemptId).nextDueMs, null);
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

test('publish recovery reviews every page before declaring reconciliation complete', async () =>
  fixture(async (ctx) => {
    for (const attemptId of ctx.ids) {
      assert.equal(ctx.queue.claimNext({ nowMs: 1_000 }).attemptId, attemptId);
    }
    ctx.reopen();
    assert.deepEqual(ctx.queue.reconcileUnresolved({ nowMs: 1_001, limit: 1 }),
      { state: 'reviewed', resolved: ctx.ids, held: [] });
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
