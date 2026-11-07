import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openProvisionalLinkQueue, createProvisionalLinkWorker } from
  '../src/acquisition/provisional-link-queue.mjs';

async function fixture(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-link-queue-'));
  const dbPath = path.join(root, 'state.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE handoff_intents (
    attempt_id INTEGER PRIMARY KEY, manifest_json TEXT NOT NULL,
    status TEXT NOT NULL);
    INSERT INTO handoff_intents VALUES
      (1, '{"identity":"provisional"}', 'published_observed'),
      (2, '{"identity":"provisional"}', 'published_observed'),
      (3, '{"identity":"anidb"}', 'published_observed');`);
  db.close();
  let queue = openProvisionalLinkQueue(dbPath);
  try {
    await run({ get queue() { return queue; },
      reopen() { queue.close(); queue = openProvisionalLinkQueue(dbPath); } });
  } finally {
    queue.close();
    await rm(root, { recursive: true, force: true });
  }
}

test('a Shoko-native wait is durable and does not block a later provisional file', async () =>
  fixture(async (ctx) => {
    const worker = createProvisionalLinkWorker({ queue: ctx.queue,
      now: () => 1_000, processAttempt: async ({ attemptId }) =>
        attemptId === 1
          ? { state: 'held', reason: 'shoko_native_match_pending' }
          : { state: 'shoko_files_identified', fileIds: [20] } });
    assert.equal((await worker.runOnce()).attemptId, 1);
    assert.equal(ctx.queue.getResult(1).nextDueMs, 601_000);
    assert.equal((await worker.runOnce()).attemptId, 2);
    assert.deepEqual(await worker.runOnce(), { state: 'idle' });
    ctx.reopen();
    assert.equal(ctx.queue.claimNext({ nowMs: 600_999 }).state, 'idle');
    assert.equal(ctx.queue.claimNext({ nowMs: 601_000 }).attemptId, 1);
  }));

test('a Shoko fallback wait retries after Shoko can identify the file', async () =>
  fixture(async (ctx) => {
    let matched = false;
    let time = 1_000;
    const processAttempt = async ({ attemptId }) =>
      attemptId === 1 && !matched
        ? { state: 'held', reason: 'shoko_fallback_pending' }
        : { state: 'shoko_files_identified', fileIds: [20] };
    const worker = createProvisionalLinkWorker({ queue: ctx.queue,
      now: () => time, processAttempt });
    assert.equal((await worker.runOnce()).attemptId, 1);
    assert.equal(ctx.queue.getResult(1).nextDueMs, 601_000);
    assert.equal((await worker.runOnce()).attemptId, 2);
    ctx.reopen();
    matched = true;
    time = 601_000;
    const restarted = createProvisionalLinkWorker({ queue: ctx.queue,
      now: () => time, processAttempt });
    assert.equal((await restarted.runOnce()).attemptId, 1);
    assert.equal(ctx.queue.getResult(1).state, 'shoko_files_identified');
  }));

test('an interrupted claim is recovered for re-observation after restart', async () =>
  fixture(async (ctx) => {
    assert.equal(ctx.queue.claimNext({ nowMs: 1_000 }).attemptId, 1);
    ctx.reopen();
    assert.deepEqual(ctx.queue.reconcileUnresolved({ nowMs: 2_000 }),
      { state: 'reviewed', resolved: [1], held: [] });
    assert.equal(ctx.queue.getResult(1).reason, 'interrupted_link_attempt');
    assert.equal(ctx.queue.claimNext({ nowMs: 301_999 }).attemptId, 2);
    assert.equal(ctx.queue.claimNext({ nowMs: 302_000 }).attemptId, 1);
  }));

test('restart recovery visits every claim in bounded pages', async () =>
  fixture(async (ctx) => {
    assert.equal(ctx.queue.claimNext({ nowMs: 1_000 }).attemptId, 1);
    assert.equal(ctx.queue.claimNext({ nowMs: 1_000 }).attemptId, 2);
    ctx.reopen();
    assert.deepEqual(ctx.queue.reconcileUnresolved({ nowMs: 2_000, limit: 1 }),
      { state: 'reviewed', resolved: [1, 2], held: [] });
  }));

test('a conflicting Shoko identity stays held for review without repeated writes', async () =>
  fixture(async (ctx) => {
    const claim = ctx.queue.claimNext({ nowMs: 1_000 });
    assert.deepEqual(ctx.queue.recordResult({ ...claim, checkedMs: 1_001,
      state: 'held', reason: 'shoko_identity_conflict' }),
    { state: 'recorded' });
    assert.equal(ctx.queue.getResult(1).nextDueMs, null);
    assert.equal(ctx.queue.claimNext({ nowMs: 100_000_000 }).attemptId, 2);
    assert.equal(ctx.queue.listReviewNeeded()[0].attemptId, 1);
  }));
