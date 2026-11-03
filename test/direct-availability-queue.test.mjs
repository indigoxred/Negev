import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openDirectAvailabilityQueue, createDirectAvailabilityWorker } from
  '../src/availability/direct-availability-queue.mjs';
import { openPlexCardIndex } from '../src/availability/plex-card-index.mjs';

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

test('metadata contention retains a direct arrival for the next tick', async () => {
  await fixture(async (ctx) => {
    const target = { anidbId: 42, episodeId: 1001 };
    ctx.queue.enqueue({ ...target, observedMs: 100, priority: 'event' });
    let clock = 101;
    let reads = 0;
    const worker = createDirectAvailabilityWorker({ queue: ctx.queue,
      now: () => clock, requireProof: true,
      observeTarget: async () => ++reads === 1 ? { state: 'busy' } :
        { state: 'available', proof: { fileId: 51, libraryId: 102,
          ratingKey: 500, partId: 600 } },
    });
    assert.deepEqual(await worker.runOnce(),
      { state: 'held', reason: 'metadata_busy' });
    assert.deepEqual(ctx.queue.getStatus({ ...target, nowMs: clock }),
      { state: 'unknown' });
    clock = 102;
    assert.deepEqual(await worker.runOnce(),
      { state: 'checked', target, result: 'available' });
    assert.equal(ctx.queue.getStatus({ ...target, nowMs: clock }).state,
      'available');
  });
});

test('a bounded same-file claim preserves separate episode receipts and fences', async () => {
  await fixture(async (ctx) => {
    const targets = [1001, 1002, 1003, 1004, 1005].map((episodeId) =>
      ({ anidbId: 42, episodeId }));
    for (const target of targets) ctx.queue.enqueue({ ...target, observedMs: 100 });
    const first = ctx.queue.claimNext({ nowMs: 100 });
    assert.equal(first.target.episodeId, 1001);
    const extra = ctx.queue.claimAssociated({ targets: targets.slice(1),
      nowMs: 100, limit: 3 });
    assert.deepEqual(extra.map((receipt) => receipt.target.episodeId),
      [1002, 1003, 1004]);
    assert.equal(ctx.queue.claimNext({ nowMs: 100 }).target.episodeId, 1005);
    for (const receipt of extra) {
      assert.equal(ctx.queue.recordResult({ claim: receipt, state: 'available',
        checkedMs: 101, proof: { fileId: 51, libraryId: 102,
          ratingKey: receipt.target.episodeId, partId: 900 } }).state,
      'recorded');
      assert.equal(ctx.queue.getStatus({ ...receipt.target, nowMs: 101 }).state,
        'available');
    }
    ctx.reopen();
    assert.equal(ctx.queue.claimAssociated({ targets: targets.slice(1),
      nowMs: 101, limit: 3 }).length, 0);
  });
});

test('one card withdrawal invalidates every proved episode, survives restart, and leaves another card', async () => {
  await fixture(async (ctx) => {
    const index = openPlexCardIndex(ctx.dbPath);
    try {
      const card = (ratingKey) => ({ libraryId: 102, ratingKey,
        kind: 'episode', observedMs: 10, parts: [{ libraryId: 102,
          partId: ratingKey + 100, size: 5,
          plexPath: `/source-pure/${ratingKey}.mkv` }] });
      index.recordCard(card(500)); index.recordCard(card(501));
      for (const episodeId of [1001, 1002, 1003]) {
        const target = { anidbId: 42, episodeId };
        ctx.queue.enqueue({ ...target, observedMs: 20 });
        const claim = ctx.queue.claimNext({ nowMs: 20 });
        const ratingKey = episodeId === 1003 ? 501 : 500;
        assert.equal(ctx.queue.recordResult({ claim, state: 'available',
          checkedMs: 21, proof: { fileId: 51, libraryId: 102, ratingKey,
            partId: ratingKey + 100 } }).state, 'recorded');
      }
      index.forgetCard({ libraryId: 102, ratingKey: 500, observedMs: 30 });
      ctx.reopen();
      for (const episodeId of [1001, 1002]) {
        assert.deepEqual(ctx.queue.getStatus({ anidbId: 42,
          episodeId, nowMs: 31 }), { state: 'unknown' });
      }
      assert.deepEqual(ctx.queue.getStatus({ anidbId: 42,
        episodeId: 1003, nowMs: 31 }),
      { state: 'available', verifiedAtMs: 21 });
      assert.deepEqual(ctx.queue.getRecentAvailableIds({ anidbId: 42,
        nowMs: 31 }), [1003]);
      index.recordCard({ ...card(500), observedMs: 32 });
      assert.equal(ctx.queue.claimNext({ nowMs: 32 }).state, 'claimed');
    } finally { index.close(); }
  });
});

test('card replacement invalidates a positive and rejects an in-flight old proof', async () => {
  await fixture(async (ctx) => {
    const index = openPlexCardIndex(ctx.dbPath);
    try {
      const card = (partId, observedMs) => ({ libraryId: 102,
        ratingKey: 500, kind: 'episode', observedMs,
        parts: [{ libraryId: 102, partId, size: 5,
          plexPath: `/source-pure/${partId}.mkv` }] });
      index.recordCard(card(600, 10));
      const target = { anidbId: 42, episodeId: 1001 };
      ctx.queue.enqueue({ ...target, observedMs: 20 });
      let claim = ctx.queue.claimNext({ nowMs: 20 });
      const proof = { fileId: 51, libraryId: 102, ratingKey: 500,
        partId: 600 };
      ctx.queue.recordResult({ claim, state: 'available', checkedMs: 21, proof });
      index.recordCard(card(601, 30));
      assert.deepEqual(ctx.queue.getStatus({ ...target, nowMs: 31 }),
        { state: 'unknown' });
      claim = ctx.queue.claimNext({ nowMs: 31 });
      index.forgetCard({ libraryId: 102, ratingKey: 500, observedMs: 32 });
      assert.deepEqual(ctx.queue.recordResult({ claim,
        state: 'available', checkedMs: 33, proof }),
      { state: 'held', reason: 'card_changed' });
      assert.deepEqual(ctx.queue.getStatus({ ...target, nowMs: 33 }),
        { state: 'unknown' });
    } finally { index.close(); }
  });
});

test('unchanged Plex refresh preserves proof but a card identity remap invalidates it', async () => {
  await fixture(async (ctx) => {
    const index = openPlexCardIndex(ctx.dbPath);
    try {
      const card = (observedMs, itemGuid) => ({ libraryId: 102,
        ratingKey: 500, kind: 'episode', observedMs,
        parts: [{ libraryId: 102, partId: 600, size: 5,
          plexPath: '/source-pure/500.mkv', itemGuid }] });
      index.recordCard(card(10, 'shoko://episode/1'));
      const target = { anidbId: 42, episodeId: 1001 };
      ctx.queue.enqueue({ ...target, observedMs: 20 });
      const claim = ctx.queue.claimNext({ nowMs: 20 });
      ctx.queue.recordResult({ claim, state: 'available', checkedMs: 21,
        proof: { fileId: 51, libraryId: 102, ratingKey: 500,
          partId: 600 } });
      index.recordCard(card(30, 'shoko://episode/1'));
      assert.deepEqual(ctx.queue.getStatus({ ...target, nowMs: 31 }),
        { state: 'available', verifiedAtMs: 21 });
      index.recordCard(card(32, 'shoko://episode/2'));
      assert.deepEqual(ctx.queue.getStatus({ ...target, nowMs: 33 }),
        { state: 'unknown' });
    } finally { index.close(); }
  });
});

test('a delayed card page rejects an in-flight proof even with an earlier page timestamp', async () => {
  await fixture(async (ctx) => {
    const index = openPlexCardIndex(ctx.dbPath);
    try {
      const card = (partId, observedMs) => ({ libraryId: 102,
        ratingKey: 500, kind: 'episode', observedMs,
        parts: [{ libraryId: 102, partId, size: 5,
          plexPath: `/source-pure/${partId}.mkv` }] });
      index.recordCard(card(600, 10));
      const target = { anidbId: 42, episodeId: 1001 };
      ctx.queue.enqueue({ ...target, observedMs: 20 });
      const claim = ctx.queue.claimNext({ nowMs: 20 });
      index.recordCard(card(601, 15));
      assert.deepEqual(ctx.queue.recordResult({ claim,
        state: 'available', checkedMs: 21,
        proof: { fileId: 51, libraryId: 102, ratingKey: 500,
          partId: 600 } }), { state: 'held', reason: 'card_changed' });
    } finally { index.close(); }
  });
});

test('production worker treats a malformed or missing card proof as Unknown', async () => {
  await fixture(async (ctx) => {
    const first = { anidbId: 42, episodeId: 1001 };
    const second = { anidbId: 42, episodeId: 1002 };
    ctx.queue.enqueue({ ...first, observedMs: 20 });
    ctx.queue.enqueue({ ...second, observedMs: 20 });
    const worker = createDirectAvailabilityWorker({ queue: ctx.queue,
      now: () => 21, requireProof: true,
      observeTarget: async (target) => target.episodeId === 1001
        ? { state: 'available' } :
        { state: 'available', proof: { libraryId: 102 } } });
    assert.equal((await worker.runOnce()).result, 'unknown');
    assert.equal((await worker.runOnce()).result, 'unknown');
    assert.deepEqual(ctx.queue.getStatus({ ...first, nowMs: 21 }),
      { state: 'unknown' });
    assert.deepEqual(ctx.queue.getStatus({ ...second, nowMs: 21 }),
      { state: 'unknown' });
  });
});

test('card index opened first still invalidates a later availability queue', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-card-first-'));
  const dbPath = path.join(root, 'state.sqlite');
  const index = openPlexCardIndex(dbPath);
  const queue = openDirectAvailabilityQueue(dbPath);
  try {
    const card = (partId, observedMs) => ({ libraryId: 102,
      ratingKey: 500, kind: 'episode', observedMs,
      parts: [{ libraryId: 102, partId, size: 5,
        plexPath: `/source-pure/${partId}.mkv` }] });
    index.recordCard(card(600, 10));
    const target = { anidbId: 42, episodeId: 1001 };
    queue.enqueue({ ...target, observedMs: 20 });
    const claim = queue.claimNext({ nowMs: 20 });
    queue.recordResult({ claim, state: 'available', checkedMs: 21,
      proof: { fileId: 51, libraryId: 102, ratingKey: 500,
        partId: 600 } });
    index.recordCard(card(601, 30));
    assert.deepEqual(queue.getStatus({ ...target, nowMs: 31 }),
      { state: 'unknown' });
  } finally {
    queue.close(); index.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('direct availability worker allows only one Plex comparison at a time', async () => {
  await fixture(async (ctx) => {
    const first = { anidbId: 42, episodeId: 1001 };
    const second = { anidbId: 42, episodeId: 1002 };
    ctx.queue.enqueue({ ...first, observedMs: 100 });
    ctx.queue.enqueue({ ...second, observedMs: 100 });
    let release;
    const waiting = new Promise((resolve) => { release = resolve; });
    const observed = [];
    const worker = createDirectAvailabilityWorker({ queue: ctx.queue,
      observeTarget: async (target) => {
        observed.push(target);
        if (target.episodeId === 1001) await waiting;
        return { state: 'unknown' };
      }, now: () => 101 });
    const active = worker.runOnce();
    assert.deepEqual(await worker.runOnce(),
      { state: 'held', reason: 'check_in_progress' });
    assert.deepEqual(observed, [first]);
    release();
    assert.equal((await active).state, 'checked');
    assert.equal((await worker.runOnce()).state, 'checked');
    assert.deepEqual(observed, [first, second]);
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

test('a same-millisecond Shoko event invalidates an available badge', async () => {
  await fixture(async (ctx) => {
    const target = { anidbId: 42, episodeId: 1001 };
    ctx.queue.enqueue({ ...target, observedMs: 100 });
    const claim = ctx.queue.claimNext({ nowMs: 100 });
    ctx.queue.recordResult({ claim, state: 'available', checkedMs: 100 });
    assert.equal(ctx.queue.enqueue({ ...target, observedMs: 100,
      priority: 'event' }).state, 'queued');
    assert.deepEqual(ctx.queue.getStatus({ ...target, nowMs: 100 }),
      { state: 'unknown' });
    assert.equal(ctx.queue.claimNext({ nowMs: 100 }).state, 'claimed');
  });
});

test('a same-millisecond event rejects an in-flight older proof', async () => {
  await fixture(async (ctx) => {
    const target = { anidbId: 42, episodeId: 1001 };
    ctx.queue.enqueue({ ...target, observedMs: 100 });
    const claim = ctx.queue.claimNext({ nowMs: 100 });
    ctx.queue.enqueue({ ...target, observedMs: 100, priority: 'event' });
    assert.deepEqual(ctx.queue.recordResult({ claim, state: 'available',
      checkedMs: 100 }), { state: 'held', reason: 'stale_claim' });
    assert.deepEqual(ctx.queue.getStatus({ ...target, nowMs: 100 }),
      { state: 'unknown' });
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
    assert.deepEqual(ctx.queue.getRecentAvailableIds({ anidbId: 42,
      nowMs: 101 }), [1001]);
    assert.deepEqual(ctx.queue.getRecentAvailableIds({ anidbId: 42,
      nowMs: 101 + 30 * 60_000 }), []);
    assert.deepEqual(ctx.queue.getCoverage({ anidbId: 42,
      episodeIds: [1001, 1002], nowMs: 100 }),
    { verifiedTargets: 0, targetCount: 2 });
    assert.deepEqual(ctx.queue.getCoverage({ anidbId: 42,
      episodeIds: [1001, 1002], nowMs: 101 + 30 * 60_000 }),
    { verifiedTargets: 0, targetCount: 2 });
  });
});

test('a future-only watch has zero verified and zero requested targets', async () => {
  await fixture(async (ctx) => {
    assert.deepEqual(ctx.queue.getCoverage({ anidbId: 42,
      episodeIds: [], nowMs: 100 }), { verifiedTargets: 0, targetCount: 0 });
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

test('a recent Shoko event retries ahead of backfill when Plex indexes after the first check', async () => {
  await fixture(async (ctx) => {
    ctx.queue.enqueue({ anidbId: 42, episodeId: 1001, observedMs: 100 });
    ctx.queue.enqueue({ anidbId: 43, episodeId: 2001,
      observedMs: 102, priority: 'event' });
    const first = ctx.queue.claimNext({ nowMs: 103 });
    assert.deepEqual(first.target, { anidbId: 43, episodeId: 2001 });
    ctx.queue.recordResult({ claim: first, state: 'unknown', checkedMs: 103 });
    ctx.reopen();
    const retry = ctx.queue.claimNext({ nowMs: 103 + 5 * 60_000 });
    assert.deepEqual(retry.target, { anidbId: 43, episodeId: 2001 });
    const verifiedMs = 103 + 5 * 60_000;
    ctx.queue.recordResult({ claim: retry, state: 'available',
      checkedMs: verifiedMs, proof: { fileId: 51, libraryId: 102,
        ratingKey: 500, partId: 600 } });
    assert.deepEqual(ctx.queue.getStatus({ anidbId: 43, episodeId: 2001,
      nowMs: verifiedMs }), { state: 'available', verifiedAtMs: verifiedMs });
  });
});

test('a late unresolved event returns to ordinary priority after its short retry window', async () => {
  await fixture(async (ctx) => {
    ctx.queue.enqueue({ anidbId: 42, episodeId: 1001, observedMs: 100 });
    ctx.queue.enqueue({ anidbId: 43, episodeId: 2001,
      observedMs: 102, priority: 'event' });
    const late = ctx.queue.claimNext({ nowMs: 102 + 30 * 60_000 });
    assert.deepEqual(late.target, { anidbId: 43, episodeId: 2001 });
    ctx.queue.recordResult({ claim: late, state: 'unknown',
      checkedMs: 102 + 30 * 60_000 });
    assert.deepEqual(ctx.queue.claimNext({ nowMs: 102 + 35 * 60_000 }).target,
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

test('a legacy Available row without file and card proof is due for exact recheck', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-direct-legacy-proof-'));
  const dbPath = path.join(root, 'state.sqlite');
  try {
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE direct_availability_targets (
      anidb_id INTEGER NOT NULL, episode_id INTEGER NOT NULL,
      observed_ms INTEGER NOT NULL, due_ms INTEGER NOT NULL,
      version INTEGER NOT NULL, state TEXT NOT NULL, verified_ms INTEGER,
      PRIMARY KEY(anidb_id,episode_id)) STRICT`);
    db.prepare(`INSERT INTO direct_availability_targets VALUES
      (42,1001,100,1800101,1,'available',101)`).run();
    db.close();
    const queue = openDirectAvailabilityQueue(dbPath);
    try {
      assert.deepEqual(queue.getStatus({ anidbId: 42,
        episodeId: 1001, nowMs: 102 }), { state: 'unknown' });
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
