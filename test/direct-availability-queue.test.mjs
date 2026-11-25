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

test('a direct alternate-card proof keeps its presentation across restart and invalidation', async () => {
  await fixture(async (ctx) => {
    const index = openPlexCardIndex(ctx.dbPath);
    try {
      const target = { anidbId: 42, episodeId: 1001 };
      const proof = { fileId: 51, libraryId: 102, ratingKey: 500,
        partId: 600, presentation: 'alternate_card' };
      index.recordCard({ libraryId: 102, ratingKey: 500,
        kind: 'episode', observedMs: 10,
        parts: [{ libraryId: 102, partId: 600, size: 5,
          plexPath: '/source-pure/500.mkv' }] });
      ctx.queue.enqueue({ ...target, observedMs: 20 });
      const claim = ctx.queue.claimNext({ nowMs: 20 });
      assert.deepEqual(ctx.queue.recordResult({ claim, state: 'available',
        checkedMs: 21, proof }), { state: 'recorded' });
      assert.deepEqual(ctx.queue.getStatus({ ...target, nowMs: 21 }),
        { state: 'available', verifiedAtMs: 21,
          presentation: 'alternate_card' });
      ctx.reopen();
      assert.deepEqual(ctx.queue.getStatus({ ...target, nowMs: 22 }),
        { state: 'available', verifiedAtMs: 21,
          presentation: 'alternate_card' });
      index.forgetCard({ libraryId: 102, ratingKey: 500, observedMs: 23 });
      assert.deepEqual(ctx.queue.getStatus({ ...target, nowMs: 23 }),
        { state: 'unknown' });
    } finally { index.close(); }
  });
});

test('a direct proof rejects an unsupported presentation', async () => {
  await fixture(async (ctx) => {
    const target = { anidbId: 42, episodeId: 1001 };
    ctx.queue.enqueue({ ...target, observedMs: 20 });
    const claim = ctx.queue.claimNext({ nowMs: 20 });
    assert.throws(() => ctx.queue.recordResult({ claim, state: 'available',
      checkedMs: 21, proof: { fileId: 51, libraryId: 102,
        ratingKey: 500, partId: 600, presentation: 'wrong_show' } }),
    TypeError);
  });
});

test('an older direct queue gains presentation without losing an exact positive', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-direct-migration-'));
  const dbPath = path.join(root, 'state.sqlite');
  const old = new DatabaseSync(dbPath);
  try {
    old.exec(`CREATE TABLE direct_availability_targets (
      anidb_id INTEGER NOT NULL, episode_id INTEGER NOT NULL,
      observed_ms INTEGER NOT NULL, due_ms INTEGER NOT NULL,
      version INTEGER NOT NULL, priority INTEGER NOT NULL,
      state TEXT NOT NULL, verified_ms INTEGER,
      proof_file_id INTEGER, proof_library_id INTEGER,
      proof_rating_key INTEGER, proof_part_id INTEGER,
      PRIMARY KEY(anidb_id,episode_id)) STRICT`);
    old.exec(`INSERT INTO direct_availability_targets VALUES
      (42,1001,20,1800021,1,0,'available',21,51,102,500,600)`);
  } finally { old.close(); }
  const queue = openDirectAvailabilityQueue(dbPath);
  try {
    assert.deepEqual(queue.getStatus({ anidbId: 42,
      episodeId: 1001, nowMs: 22 }),
    { state: 'available', verifiedAtMs: 21 });
  } finally { queue.close(); await rm(root, { recursive: true, force: true }); }
});

test('metadata contention retains a direct arrival for the next tick', async () => {
  await fixture(async (ctx) => {
    const target = { anidbId: 42, episodeId: 1001 };
    ctx.queue.enqueue({ ...target, observedMs: 100, priority: 'event' });
    let clock = 101;
    let reads = 0;
    const recorded = [];
    const worker = createDirectAvailabilityWorker({ queue: ctx.queue,
      now: () => clock, requireProof: true,
      onRecordedAvailable: (proof, item) =>
        recorded.push({ fileId: proof.fileId, target: item }),
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
    assert.deepEqual(recorded, [{ fileId: 51, target }]);
  });
});

test('the recorded arrival callback receives the exact card revision for guarded proof', async () => {
  await fixture(async (ctx) => {
    const target = { anidbId: 42, episodeId: 1001 };
    ctx.queue.enqueue({ ...target, observedMs: 100, priority: 'event' });
    const outcome = { state: 'available', fileId: 51,
      proof: { fileId: 51, libraryId: 102, ratingKey: 500, partId: 600 },
      cardRevision: { observedMs: 100, identitySignature: 'exact' } };
    let delivered;
    const worker = createDirectAvailabilityWorker({ queue: ctx.queue,
      now: () => 101, requireProof: true,
      observeTarget: async () => outcome,
      onRecordedAvailable: (_proof, _target, savedOutcome) => {
        delivered = savedOutcome;
      } });
    assert.equal((await worker.runOnce()).state, 'checked');
    assert.deepEqual(delivered, outcome);
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
    assert.deepEqual(ctx.queue.claimNext({ nowMs: 103 + 29_999 }).target,
      { anidbId: 42, episodeId: 1001 });
    const retry = ctx.queue.claimNext({ nowMs: 103 + 30_000 });
    assert.deepEqual(retry.target, { anidbId: 43, episodeId: 2001 });
    const verifiedMs = 103 + 30_000;
    ctx.queue.recordResult({ claim: retry, state: 'available',
      checkedMs: verifiedMs, proof: { fileId: 51, libraryId: 102,
        ratingKey: 500, partId: 600 } });
    assert.deepEqual(ctx.queue.getStatus({ anidbId: 43, episodeId: 2001,
      nowMs: verifiedMs }), { state: 'available', verifiedAtMs: verifiedMs });
  });
});

test('an unresolved new Shoko event returns to five-minute retry after a short window', async () => {
  await fixture(async (ctx) => {
    ctx.queue.enqueue({ anidbId: 43, episodeId: 2001,
      observedMs: 100, priority: 'event' });
    for (const checkedMs of [100, 30_100, 60_100, 90_100, 120_100,
      150_100]) {
      const claim = ctx.queue.claimNext({ nowMs: checkedMs });
      assert.equal(claim.state, 'claimed');
      assert.deepEqual(ctx.queue.recordResult({ claim, state: 'unknown',
        checkedMs }), { state: 'recorded' });
    }
    assert.deepEqual(ctx.queue.claimNext({ nowMs: 180_099 }),
      { state: 'idle' });
    const finalFast = ctx.queue.claimNext({ nowMs: 180_100 });
    assert.equal(finalFast.state, 'claimed');
    ctx.queue.recordResult({ claim: finalFast, state: 'unknown',
      checkedMs: 180_100 });
    assert.deepEqual(ctx.queue.claimNext({ nowMs: 180_100 + 30_000 }),
      { state: 'idle' });
    assert.equal(ctx.queue.claimNext({ nowMs: 180_100 + 5 * 60_000 }).state,
      'claimed');
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

test('a change to the second multipart file rejects an in-flight direct result',async()=>{await fixture(async ctx=>{const target={anidbId:42,episodeId:1001};ctx.queue.enqueue({...target,observedMs:100});const claim=ctx.queue.claimNext({nowMs:100});const db=new DatabaseSync(ctx.dbPath);db.prepare('INSERT INTO shoko_file_change_events(file_id,observed_ms) VALUES(8,101)').run();db.close();const parts=[7,8].map((fileId,i)=>({fileId,libraryId:102,ratingKey:500,partId:600+i,mediaId:900,partIndex:i,partCount:2}));assert.equal(ctx.queue.recordResult({claim,state:'available',checkedMs:102,proof:{...parts[0],parts}}).reason,'shoko_changed');assert.equal(ctx.queue.getStatus({...target,nowMs:102}).state,'unknown');});});


test('interactive proof advances past event backlog, survives restart and coalesces active clicks', async () => {
  await fixture(async ctx => {
    for(let i=0;i<150;i++)ctx.queue.enqueue({anidbId:100+i,episodeId:1000+i,observedMs:100,priority:'event'});
    const target={anidbId:42,episodeId:1001};
    ctx.queue.enqueue({...target,observedMs:200,priority:'event'});
    ctx.queue.enqueue({...target,observedMs:300,priority:'interactive'});
    const observed=ctx.queue.getObservation(target);
    ctx.queue.enqueue({...target,observedMs:400,priority:'interactive'});
    assert.deepEqual(ctx.queue.getObservation(target),observed);
    ctx.reopen();
    const claim=ctx.queue.claimNext({nowMs:500});
    assert.deepEqual(claim.target,target);
    assert.equal(ctx.queue.enqueue({...target,observedMs:600,priority:'interactive'}).state,'unchanged');
    assert.equal(ctx.queue.retryBusy({claim,nowMs:700}).reason,'metadata_busy');const retry=ctx.queue.claimNext({nowMs:701});assert.deepEqual(retry.target,target);assert.equal(ctx.queue.recordResult({claim:retry,state:'unknown',checkedMs:702}).state,'recorded');
    assert.deepEqual(ctx.queue.claimNext({nowMs:701}).target,{anidbId:100,episodeId:1000});
  });
});

test('expired interactive priority cannot indefinitely overtake older background events',async()=>{
  await fixture(async ctx=>{
    ctx.queue.enqueue({anidbId:100,episodeId:1000,observedMs:100,priority:'event'});
    const target={anidbId:42,episodeId:1001};
    ctx.queue.enqueue({...target,observedMs:200,priority:'interactive'});
    // No new check: the original window must expire.
    ctx.reopen();
    assert.deepEqual(ctx.queue.claimNext({nowMs:60201}).target,{anidbId:100,episodeId:1000});
  });
});

test('a later explicit check can renew an expired pending window without extending a live one',async()=>{
 await fixture(async ctx=>{
 const target={anidbId:42,episodeId:1001};ctx.queue.enqueue({anidbId:100,episodeId:1000,observedMs:100,priority:'event'});ctx.queue.enqueue({...target,observedMs:200,priority:'interactive'});assert.equal(ctx.queue.enqueue({...target,observedMs:300,priority:'interactive'}).state,'unchanged');assert.equal(ctx.queue.enqueue({...target,observedMs:60201,priority:'interactive'}).state,'queued');ctx.reopen();const claim=ctx.queue.claimNext({nowMs:60202});assert.deepEqual(claim.target,target);ctx.queue.recordResult({claim,state:'unknown',checkedMs:60203});assert.deepEqual(ctx.queue.claimNext({nowMs:60204}).target,{anidbId:100,episodeId:1000});
 });
});

test('actual guarded worker card-change hold reaches the paced scheduler and succeeds on its next turn',async()=>{
 const {createDirectAvailabilityScheduler}=await import('../src/availability/direct-availability-scheduler.mjs');
 await fixture(async ctx=>{
 const index=openPlexCardIndex(ctx.dbPath),target={anidbId:42,episodeId:1001};let clock=100,first=true;const card=()=>({libraryId:102,ratingKey:500,kind:'episode',observedMs:clock,parts:[{libraryId:102,partId:600,size:5,plexPath:'/source-pure/one.mkv'}]});index.recordCard(card());ctx.queue.enqueue({...target,observedMs:clock,priority:'interactive'});const worker=createDirectAvailabilityWorker({queue:ctx.queue,now:()=>clock,requireProof:true,observeTarget:async()=>{if(first){first=false;index.forgetCard({libraryId:102,ratingKey:500,observedMs:++clock});}return{state:'available',proof:{fileId:51,libraryId:102,ratingKey:500,partId:600}}}});const timers=[],outcomes=[];const scheduler=createDirectAvailabilityScheduler({runOnce:async()=>{const r=await worker.runOnce();outcomes.push(r);return r},initialDelayMs:1000,activeDelayMs:10000,idleDelayMs:60000,setTimer:(fn,delay)=>{timers.push({fn,delay});return timers.length},clearTimer:()=>{}});try{scheduler.start();clock=1100;await timers.shift().fn();assert.equal(outcomes[0].reason,'card_changed');assert.equal(timers[0].delay,10000);clock=11100;index.recordCard(card());await timers.shift().fn();assert.equal(outcomes[1].state,'checked');assert.equal(ctx.queue.getStatus({...target,nowMs:clock}).state,'available');}finally{await scheduler.close();index.close();}
 });
});

test('newer pending arrivals and a 6201-row prefix share 180 worker turns over 36 minutes across reopen',async()=>fixture(async ctx=>{
 const db=new DatabaseSync(ctx.dbPath),oldTime=100,newTime=200,clock=14*60*60_000;
 try{
  const insert=db.prepare("INSERT INTO direct_availability_targets(anidb_id,episode_id,observed_ms,due_ms,version,priority,state) VALUES(1,?,?,?,1,1,'pending')");
  db.exec('BEGIN');for(let id=1;id<=6201;id++)insert.run(id,oldTime,oldTime);db.exec('COMMIT');
  ctx.queue.enqueue({anidbId:2,episodeId:7001,observedMs:newTime,priority:'event'});
  const visited=[];
  for(let tick=0;tick<180;tick++){
   if(tick>=2&&tick%2===0)ctx.queue.enqueue({anidbId:2,episodeId:7000+tick,observedMs:newTime+tick,priority:'event'});
   ctx.reopen();
   const worker=createDirectAvailabilityWorker({queue:ctx.queue,now:()=>clock+tick*12_000,requireProof:true,
    observeTarget:async target=>{visited.push(target.episodeId);return {state:'available',proof:{fileId:51,libraryId:102,ratingKey:500,partId:600}};}});
   await worker.runOnce();
  }
  assert.ok(visited.indexOf(7001)>=0&&visited.indexOf(7001)<=1,JSON.stringify(visited));
  assert.deepEqual(visited.filter(id=>id<=6201),Array.from({length:90},(_,i)=>i+1));
  for(const id of [7001,...Array.from({length:89},(_,i)=>7002+i*2)])assert.ok(visited.includes(id),JSON.stringify(visited));
  assert.equal(db.prepare('SELECT observed_ms t FROM direct_availability_targets WHERE episode_id=7001').get().t,newTime);
 }finally{db.close();}
}));

test('busy and failing arrivals retain fair old progress, backoff and original evidence across every reopen',async()=>fixture(async ctx=>{
 const db=new DatabaseSync(ctx.dbPath);let nowMs=10_000_000;const seen=[];let busy=true;
 try{
  for(let id=1;id<=12;id++)ctx.queue.enqueue({anidbId:1,episodeId:id,observedMs:100,priority:'event'});
  ctx.queue.enqueue({anidbId:2,episodeId:100,observedMs:200,priority:'event'});
  for(let tick=0;tick<8;tick++){
   ctx.reopen();const worker=createDirectAvailabilityWorker({queue:ctx.queue,now:()=>nowMs,
    observeTarget:async target=>{seen.push(target.episodeId);if(target.episodeId===100&&busy){busy=false;return{state:'busy'};}return {state:'unknown'};}});
   await worker.runOnce();nowMs++;
  }
  assert.deepEqual(seen,[100,1,100,2,3,4,5,6]);
  const row=db.prepare('SELECT observed_ms observed,due_ms due,state,priority FROM direct_availability_targets WHERE episode_id=100').get();
  assert.equal(row.observed,200);assert.equal(row.state,'unknown');assert.equal(row.priority,0);
  assert.equal(row.due,10_000_002+300_000,'an aged miss keeps the five-minute backoff');
 }finally{db.close();}
}));

test('legacy pending queue initializes fairness once without rewriting observations or active leases',async()=>fixture(async ctx=>{
 const db=new DatabaseSync(ctx.dbPath);
 try{
  for(let id=1;id<=3;id++)ctx.queue.enqueue({anidbId:1,episodeId:id,observedMs:100,priority:'event'});
  const inFlight=ctx.queue.claimNext({nowMs:100});
  db.exec('DROP TABLE direct_availability_fairness'); // frozen pre-fairness schema
  const before=db.prepare('SELECT * FROM direct_availability_targets WHERE episode_id=1').get();
  ctx.queue.enqueue({anidbId:2,episodeId:100,observedMs:200,priority:'event'});
  ctx.reopen();ctx.reopen();
  assert.deepEqual(db.prepare('SELECT * FROM direct_availability_targets WHERE episode_id=1').get(),before);
  assert.equal(ctx.queue.claimNext({nowMs:200}).target.episodeId,100);
  ctx.reopen();assert.equal(ctx.queue.claimNext({nowMs:200}).target.episodeId,2);
  assert.equal(ctx.queue.recordResult({claim:inFlight,state:'unknown',checkedMs:201}).state,'recorded');
  assert.equal(ctx.queue.getObservation({anidbId:1,episodeId:1}).observedMs,100);
 }finally{db.close();}
}));

test('a fair new-lane worker still rejects a concurrent enqueue and saves only its new generation',async()=>fixture(async ctx=>{
 ctx.queue.enqueue({anidbId:1,episodeId:1,observedMs:100,priority:'event'});
 ctx.queue.enqueue({anidbId:2,episodeId:100,observedMs:200,priority:'event'});
 let nowMs=300,replaced=false,callbacks=0;
 const makeWorker=()=>createDirectAvailabilityWorker({queue:ctx.queue,now:()=>nowMs,requireProof:true,
  onRecordedAvailable:()=>callbacks++,observeTarget:async target=>{
   if(target.episodeId===100&&!replaced){replaced=true;ctx.queue.enqueue({...target,observedMs:301,priority:'event'});}
   return{state:'available',proof:{fileId:51,libraryId:102,ratingKey:500,partId:600}};
  }});
 assert.equal((await makeWorker().runOnce()).reason,'stale_claim');
 assert.equal(ctx.queue.getStatus({anidbId:2,episodeId:100,nowMs}).state,'unknown');ctx.reopen();
 nowMs=301;assert.equal((await makeWorker().runOnce()).state,'checked');
 ctx.reopen();nowMs=302;assert.equal((await makeWorker().runOnce()).state,'checked');
 assert.equal(callbacks,2);assert.equal(ctx.queue.getObservation({anidbId:2,episodeId:100}).observedMs,301);
}));

test('ordinary priority-zero history receives bounded turns during continuous event intake',async()=>fixture(async ctx=>{
 ctx.queue.enqueue({anidbId:1,episodeId:1,observedMs:0,priority:'reconcile'});
 const visited=[];
 for(let tick=0;tick<8;tick++){
  ctx.queue.enqueue({anidbId:2,episodeId:100+tick,observedMs:100+tick,priority:'event'});
  ctx.reopen();const worker=createDirectAvailabilityWorker({queue:ctx.queue,now:()=>100+tick,
   observeTarget:async target=>{visited.push(target.episodeId);return{state:'unknown'};}});
  await worker.runOnce();
 }
 assert.ok(visited.indexOf(1)>=0&&visited.indexOf(1)<=1,JSON.stringify(visited));
}));
