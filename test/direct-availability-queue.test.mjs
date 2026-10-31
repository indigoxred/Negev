import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openDirectAvailabilityQueue, createDirectAvailabilityWorker } from
  '../src/availability/direct-availability-queue.mjs';

async function fixture(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-direct-availability-'));
  const dbPath = path.join(root, 'state.sqlite');
  let queue = openDirectAvailabilityQueue(dbPath);
  try { await run({ dbPath, get queue() { return queue; },
    reopen() { queue.close(); queue = openDirectAvailabilityQueue(dbPath); } }); }
  finally { queue.close(); await rm(root, { recursive: true, force: true }); }
}

test('direct Shoko arrival is Unknown until exact public Plex proof, then expires', async () => {
  await fixture(async (ctx) => {
    const target = { anidbId: 42, episodeId: 1001 };
    assert.deepEqual(ctx.queue.enqueue({ ...target, observedMs: 100 }),
      { state: 'queued' });
    assert.deepEqual(ctx.queue.getStatus({ ...target, nowMs: 100 }),
      { state: 'unknown' });
    const worker = createDirectAvailabilityWorker({ queue: ctx.queue,
      observeTarget: async (item) => {
        assert.deepEqual(item, target);
        return { state: 'available' };
      }, now: () => 101 });
    assert.deepEqual(await worker.runOnce(), { state: 'checked',
      target, result: 'available' });
    assert.deepEqual(ctx.queue.getStatus({ ...target, nowMs: 101 }),
      { state: 'available', verifiedAtMs: 101 });
    assert.deepEqual(ctx.queue.getStatus({ ...target, nowMs: 100 }),
      { state: 'unknown' });
    ctx.reopen();
    assert.deepEqual(ctx.queue.getStatus({ ...target, nowMs: 101 + 30 * 60_000 }),
      { state: 'unknown' });
  });
});

test('new Shoko evidence invalidates a prior badge and prevents stale in-flight proof', async () => {
  await fixture(async (ctx) => {
    const target = { anidbId: 42, episodeId: 1001 };
    ctx.queue.enqueue({ ...target, observedMs: 100 });
    const claim = ctx.queue.claimNext({ nowMs: 100 });
    ctx.queue.enqueue({ ...target, observedMs: 101 });
    assert.deepEqual(ctx.queue.recordResult({ claim, state: 'available', checkedMs: 102 }),
      { state: 'held', reason: 'stale_claim' });
    assert.deepEqual(ctx.queue.getStatus({ ...target, nowMs: 102 }),
      { state: 'unknown' });
    const newer = ctx.queue.claimNext({ nowMs: 102 });
    assert.notEqual(newer.version, claim.version);
    assert.equal(ctx.queue.recordResult({ claim: newer,
      state: 'available', checkedMs: 103 }).state, 'recorded');
    assert.deepEqual(ctx.queue.getStatus({ ...target, nowMs: 103 }),
      { state: 'available', verifiedAtMs: 103 });
  });
});

test('uncertain Plex check retries later while another direct import advances', async () => {
  await fixture(async (ctx) => {
    const first = { anidbId: 42, episodeId: 1001 };
    const second = { anidbId: 43, episodeId: 2001 };
    ctx.queue.enqueue({ ...first, observedMs: 100 });
    ctx.queue.enqueue({ ...second, observedMs: 101 });
    const worker = createDirectAvailabilityWorker({ queue: ctx.queue,
      observeTarget: async (target) => target.anidbId === 42
        ? { state: 'unknown', reason: 'observer_incomplete' }
        : { state: 'available' }, now: () => 102 });
    assert.deepEqual(await worker.runOnce(), { state: 'checked',
      target: first, result: 'unknown' });
    assert.deepEqual(await worker.runOnce(), { state: 'checked',
      target: second, result: 'available' });
    assert.deepEqual(ctx.queue.getStatus({ ...first, nowMs: 103 }),
      { state: 'unknown' });
    assert.equal(ctx.queue.claimNext({ nowMs: 102 }).state, 'idle');
    assert.equal(ctx.queue.claimNext({ nowMs: 102 + 5 * 60_000 }).state,
      'claimed');
  });
});

test('coverage counts only current exact positives and never counts unknown targets', async () => {
  await fixture(async (ctx) => {
    const first = { anidbId: 42, episodeId: 1001 };
    ctx.queue.enqueue({ ...first, observedMs: 100 });
    const claim = ctx.queue.claimNext({ nowMs: 100 });
    ctx.queue.recordResult({ claim, state: 'available', checkedMs: 101 });
    assert.deepEqual(ctx.queue.getCoverage({ anidbId: 42,
      episodeIds: [1001, 1002], nowMs: 101 }),
    { verifiedTargets: 1, targetCount: 2 });
    assert.deepEqual(ctx.queue.getCoverage({ anidbId: 42,
      episodeIds: [1001, 1002], nowMs: 100 }),
    { verifiedTargets: 0, targetCount: 2 });
    assert.deepEqual(ctx.queue.getCoverage({ anidbId: 42,
      episodeIds: [1001, 1002], nowMs: 101 + 30 * 60_000 }),
    { verifiedTargets: 0, targetCount: 2 });
  });
});

test('a fresh Shoko event runs before older inventory backfill without starving later work', async () => {
  await fixture(async (ctx) => {
    ctx.queue.enqueue({ anidbId: 42, episodeId: 1001, observedMs: 100 });
    ctx.queue.enqueue({ anidbId: 42, episodeId: 1002, observedMs: 101 });
    ctx.queue.enqueue({ anidbId: 43, episodeId: 2001,
      observedMs: 102, priority: 'event' });
    const urgent = ctx.queue.claimNext({ nowMs: 103 });
    assert.deepEqual(urgent.target, { anidbId: 43, episodeId: 2001 });
    ctx.queue.recordResult({ claim: urgent, state: 'unknown', checkedMs: 103 });
    assert.deepEqual(ctx.queue.claimNext({ nowMs: 104 }).target,
      { anidbId: 42, episodeId: 1001 });
  });
});

test('a prior durable queue gains event priority without losing a pending target', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-direct-migrate-'));
  const dbPath = path.join(root, 'state.sqlite');
  try {
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE direct_availability_targets (
      anidb_id INTEGER NOT NULL, episode_id INTEGER NOT NULL,
      observed_ms INTEGER NOT NULL, due_ms INTEGER NOT NULL,
      version INTEGER NOT NULL, state TEXT NOT NULL, verified_ms INTEGER,
      PRIMARY KEY(anidb_id,episode_id)) STRICT`);
    db.prepare(`INSERT INTO direct_availability_targets VALUES
      (42,1001,100,100,1,'pending',NULL)`).run();
    db.close();
    const queue = openDirectAvailabilityQueue(dbPath);
    try {
      queue.enqueue({ anidbId: 43, episodeId: 2001,
        observedMs: 101, priority: 'event' });
      assert.deepEqual(queue.claimNext({ nowMs: 102 }).target,
        { anidbId: 43, episodeId: 2001 });
      assert.deepEqual(queue.claimNext({ nowMs: 102 }).target,
        { anidbId: 42, episodeId: 1001 });
    } finally { queue.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a clock rollback cannot save a future availability proof', async () => {
  await fixture(async (ctx) => {
    const target = { anidbId: 42, episodeId: 1001 };
    ctx.queue.enqueue({ ...target, observedMs: 200 });
    const claim = ctx.queue.claimNext({ nowMs: 200 });
    assert.deepEqual(ctx.queue.recordResult({ claim,
      state: 'available', checkedMs: 199 }),
    { state: 'held', reason: 'clock_regressed' });
    assert.deepEqual(ctx.queue.getStatus({ ...target, nowMs: 201 }),
      { state: 'unknown' });
  });
});
