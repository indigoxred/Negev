import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { openAcquisitionLedger } from '../src/acquisition/acquisition-ledger.mjs';
import { openAcquisitionRequestQueue } from '../src/acquisition/acquisition-request-queue.mjs';
import { openHandoffLedger } from '../src/acquisition/handoff-ledger.mjs';
import { openPureMoveLedger } from '../src/acquisition/pure-move-ledger.mjs';
import { openCompletionQueue, createCompletionWorker } from '../src/acquisition/completion-queue.mjs';
import { createPipelineScheduler } from '../src/acquisition/acquisition-pipeline-scheduler.mjs';
import { evaluateHandoffEvidence } from '../src/acquisition/handoff-evidence.mjs';
import { openRequestProgress } from '../src/requests/request-progress.mjs';

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
      get queue() { return queue; },
      closeQueue() { queue.close(); queue = null; },
      reopen() { queue?.close(); queue = openCompletionQueue(dbPath); } });
  } finally {
    queue?.close(); handoffs.close(); acquisitions.close(); requests.close();
    await rm(root, { recursive: true, force: true });
  }
}

test('pure completion uses separate cursor and checks alongside legacy queue', async () => {
  await fixture(async (ctx) => {
    const pureMoves = openPureMoveLedger(ctx.dbPath);
    const pureQueue = openCompletionQueue(ctx.dbPath, { pureMode: true });
    try {
      assert.equal(ctx.queue.claimNext({ nowMs: 1_000 }).attemptId, ctx.attemptIds[0]);
      assert.equal(pureQueue.claimNext({ nowMs: 1_000 }).attemptId, ctx.attemptIds[0]);
      assert.equal(ctx.queue.getResult(ctx.attemptIds[0]).state, null);
      assert.equal(pureQueue.getResult(ctx.attemptIds[0]).state, null);
      const db = new DatabaseSync(ctx.dbPath);
      try {
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM completion_checks').get().n, 1);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pure_move_completion_checks').get().n, 1);
      } finally { db.close(); }
    } finally { pureQueue.close(); pureMoves.close(); }
  });
});

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

test('cutover hold excludes completion retries across reopen until resumed', async () => {
  await fixture(async (ctx) => {
    const later = ctx.requests.submit({ requesterId: 1,
      requestKey: 'later-completion', nowMs: 800,
      intent: { state: 'ready', anidbId: 43, kind: 'series',
        monitorFuture: false, episodeIds: [2001] } });
    const candidate = { indexerId: 7, guid: 'later-completion' };
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
    const holds = openAcquisitionRequestQueue(ctx.dbPath);
    try {
      assert.deepEqual(holds.suspendForCutover({ requestId: 1,
        reason: 'cutover_review', nowMs: 900 }), { state: 'suspended' });
      assert.equal(ctx.queue.claimNext({ nowMs: 1_000 }).attemptId, laterId);
      assert.equal(ctx.queue.claimNext({ nowMs: 1_000 }).state,
        'pass_complete');
      ctx.reopen();
      assert.equal(ctx.queue.claimNext({ nowMs: 1_001 }).state,
        'pass_complete');
      assert.deepEqual(holds.resumeSuspended({ requestId: 1 }),
        { state: 'resumed' });
      assert.equal(ctx.queue.claimNext({ nowMs: 1_002 }).attemptId,
        ctx.attemptIds[0]);
    } finally { holds.close(); }
  });
});

test('a measured transfer is request-scoped, durable, and expires before it can look live', async () => {
  await fixture(async (ctx) => {
    const other = ctx.requests.submit({ requesterId: 2,
      requestKey: 'other', nowMs: 500,
      intent: { state: 'ready', anidbId: 99, kind: 'movie',
        monitorFuture: false, episodeIds: [9999] } });
    const worker = createCompletionWorker({ queue: ctx.queue, now: () => 1_000,
      processAttempt: async () => ({ state: 'held', reason: 'incomplete',
        transfer: { progressBasisPoints: 3750, etaSeconds: 120,
          speedBytesPerSecond: 512, transferState: 'active' } }) });
    assert.equal((await worker.runOnce()).state, 'processed');
    ctx.reopen();
    const recent = openRequestProgress(ctx.dbPath, { now: () => 1_000 });
    const expired = openRequestProgress(ctx.dbPath, { now: () => 1_000 + 16 * 60_000 });
    try {
      assert.deepEqual(recent.read(1).transfer, {
        progressBasisPoints: 3750, etaSeconds: 120,
        speedBytesPerSecond: 512, transferState: 'active',
        observedMs: 1_000 });
      assert.equal(expired.read(1).transfer, undefined);
      assert.equal(recent.read(other.requestId).transfer, undefined);
      assert.equal(recent.read(999), null);
      assert.equal(ctx.acquisitions.requestStalledRetirement({
        attemptId: ctx.attemptIds[0], hash: ctx.hashes[0],
        nowMs: 1_001 }).state, 'retirement_requested');
      assert.equal(recent.read(1).transfer, undefined,
        'a retirement intent invalidates the old download snapshot');
    } finally { recent.close(); expired.close(); }
  });
});

test('repeated inconclusive release lookups back off without losing a restart', async () => {
  for (const reason of ['file_lookup_inconclusive',
    'file_offline_lookup_inconclusive']) {
  await fixture(async (ctx) => {
    for (let i = 1; i < 3; i++) {
      ctx.acquisitions.requestStalledRetirement({ attemptId: ctx.attemptIds[i],
        hash: ctx.hashes[i], nowMs: 1_000 });
    }
    let checkedMs = 1_000;
    for (const delay of [30 * 60_000, 2 * 60 * 60_000,
      8 * 60 * 60_000, 24 * 60 * 60_000, 24 * 60 * 60_000]) {
      const claim = ctx.queue.claimNext({ nowMs: checkedMs });
      assert.equal(claim.attemptId, ctx.attemptIds[0]);
      assert.deepEqual(ctx.queue.recordResult({ attemptId: claim.attemptId,
        pass: claim.pass, state: 'held', reason,
        checkedMs }), { state: 'recorded' });
      assert.equal(ctx.queue.getResult(claim.attemptId).nextDueMs,
        checkedMs + delay);
      assert.equal(ctx.queue.claimNext({ nowMs: checkedMs }).state,
        'pass_complete');
      ctx.reopen();
      assert.equal(ctx.queue.claimNext({ nowMs: checkedMs + delay - 1 }).state,
        'pass_complete');
      checkedMs += delay;
    }
  });
  }
});

test('a different completion hold resets the inconclusive lookup delay', async () => {
  await fixture(async (ctx) => {
    for (let i = 1; i < 3; i++) {
      ctx.acquisitions.requestStalledRetirement({ attemptId: ctx.attemptIds[i],
        hash: ctx.hashes[i], nowMs: 1_000 });
    }
    let checkedMs = 1_000;
    for (const [reason, delay] of [
      ['file_lookup_inconclusive', 30 * 60_000],
      ['file_lookup_inconclusive', 2 * 60 * 60_000],
      ['provider_unavailable', 30 * 60_000],
      ['file_lookup_inconclusive', 30 * 60_000],
    ]) {
      const claim = ctx.queue.claimNext({ nowMs: checkedMs });
      assert.equal(claim.attemptId, ctx.attemptIds[0]);
      ctx.queue.recordResult({ attemptId: claim.attemptId, pass: claim.pass,
        state: 'held', reason, checkedMs });
      assert.equal(ctx.queue.getResult(claim.attemptId).nextDueMs,
        checkedMs + delay);
      assert.equal(ctx.queue.claimNext({ nowMs: checkedMs }).state,
        'pass_complete');
      checkedMs += delay;
    }
  });
});

test('old completion rows gain a zero counter without changing their due time', async () => {
  await fixture(async (ctx) => {
    const claim = ctx.queue.claimNext({ nowMs: 1_000 });
    ctx.queue.recordResult({ attemptId: claim.attemptId, pass: claim.pass,
      state: 'held', reason: 'file_lookup_inconclusive', checkedMs: 1_000 });
    const oldDueMs = ctx.queue.getResult(claim.attemptId).nextDueMs;
    ctx.closeQueue();
    const db = new DatabaseSync(ctx.dbPath);
    try {
      db.exec(`PRAGMA foreign_keys=OFF;
        CREATE TABLE old_checks (
          attempt_id INTEGER PRIMARY KEY REFERENCES acquisition_attempts(id),
          pass INTEGER NOT NULL CHECK(pass>0),
          state TEXT CHECK(state IN ('held','handoff_prepared','rejected_held')),
          reason TEXT,
          checked_ms INTEGER CHECK(checked_ms>=0),
          next_due_ms INTEGER CHECK(next_due_ms>=0)
        ) STRICT;
        INSERT INTO old_checks SELECT attempt_id,pass,state,reason,
          checked_ms,next_due_ms FROM completion_checks;
        DROP TABLE completion_checks;
        ALTER TABLE old_checks RENAME TO completion_checks;`);
    } finally { db.close(); }
    ctx.reopen();
    assert.equal(ctx.queue.getResult(claim.attemptId).nextDueMs, oldDueMs);
    const migrated = new DatabaseSync(ctx.dbPath);
    try {
      assert.equal(migrated.prepare(`SELECT inconclusive_count AS count
        FROM completion_checks WHERE attempt_id=?`).get(claim.attemptId).count, 0);
    } finally { migrated.close(); }
  });
});

test('due completion retries advance in ID order so an older retry cannot starve', async () => {
  await fixture(async (ctx) => {
    const older = ctx.queue.claimNext({ nowMs: 1_000 });
    ctx.queue.recordResult({ attemptId: older.attemptId, pass: older.pass,
      state: 'held', reason: 'file_lookup_inconclusive', checkedMs: 1_000 });
    const complete = ctx.queue.claimNext({ nowMs: 1_000 });
    ctx.queue.recordResult({ attemptId: complete.attemptId, pass: complete.pass,
      state: 'held', reason: 'incomplete', checkedMs: 1_000 });
    const other = ctx.queue.claimNext({ nowMs: 1_000 });
    ctx.queue.recordResult({ attemptId: other.attemptId, pass: other.pass,
      state: 'held', reason: 'provider_unavailable', checkedMs: 1_000 });
    assert.equal(ctx.queue.claimNext({ nowMs: 1_000 }).state, 'pass_complete');
    assert.equal(ctx.queue.claimNext({ nowMs: 1_801_000 }).attemptId,
      older.attemptId);
    assert.equal(ctx.queue.claimNext({ nowMs: 1_801_000 }).attemptId,
      complete.attemptId);
  });
});

test('an incomplete higher-ID attempt cannot starve an older due retry across paced passes', async () => {
  await fixture(async (ctx) => {
    const first = ctx.queue.claimNext({ nowMs: 1_000 });
    ctx.queue.recordResult({ attemptId: first.attemptId, pass: first.pass,
      state: 'held', reason: 'file_lookup_inconclusive', checkedMs: 1_000 });
    const second = ctx.queue.claimNext({ nowMs: 1_000 });
    ctx.queue.recordResult({ attemptId: second.attemptId, pass: second.pass,
      state: 'held', reason: 'incomplete', checkedMs: 1_000 });
    ctx.acquisitions.requestStalledRetirement({ attemptId: ctx.attemptIds[2],
      hash: ctx.hashes[2], nowMs: 1_000 });
    assert.equal(ctx.queue.claimNext({ nowMs: 1_000 }).state, 'pass_complete');
    let checkedOlder = false;
    for (let minute = 31; minute <= 79; minute += 4) {
      const nowMs = minute * 60_000 + 1_000;
      const claim = ctx.queue.claimNext({ nowMs });
      if (claim.state !== 'claimed') continue;
      if (claim.attemptId === first.attemptId) checkedOlder = true;
      ctx.queue.recordResult({ attemptId: claim.attemptId, pass: claim.pass,
        state: 'held', reason: claim.attemptId === second.attemptId
          ? 'incomplete' : 'file_lookup_inconclusive', checkedMs: nowMs });
    }
    assert.equal(checkedOlder, true);
  });
});

test('the four-stage scheduler eventually checks an older due completion retry', async () => {
  await fixture(async (ctx) => {
    for (const reason of ['file_lookup_inconclusive', 'incomplete']) {
      const claim = ctx.queue.claimNext({ nowMs: 1_000 });
      ctx.queue.recordResult({ attemptId: claim.attemptId, pass: claim.pass,
        state: 'held', reason, checkedMs: 1_000 });
    }
    ctx.acquisitions.requestStalledRetirement({ attemptId: ctx.attemptIds[2],
      hash: ctx.hashes[2], nowMs: 1_000 });
    assert.equal(ctx.queue.claimNext({ nowMs: 1_000 }).state, 'pass_complete');
    let nowMs = 30 * 60_000 + 1_000;
    let nextTimerId = 0;
    const timers = new Map();
    const seen = [];
    const worker = createCompletionWorker({ queue: ctx.queue, now: () => nowMs,
      processAttempt: async ({ attemptId }) => {
        seen.push(attemptId);
        return { state: 'held', reason: attemptId === ctx.attemptIds[1]
          ? 'incomplete' : 'file_lookup_inconclusive' };
      } });
    const scheduler = createPipelineScheduler({
      pipeline: {
        initialize: async () => ({ state: 'reconciled' }),
        tickPublish: async () => ({ state: 'idle' }),
        tickCompletions: () => worker.runOnce(),
        tickStarts: async () => ({ state: 'idle' }),
        tickRequests: async () => ({ state: 'idle' }),
        close: async () => {},
      },
      now: () => nowMs,
      setTimer: (callback, delay) => {
        const id = ++nextTimerId;
        timers.set(id, { callback, delay });
        return id;
      },
      clearTimer: (id) => timers.delete(id),
    });
    try {
      await scheduler.start();
      for (let tick = 0; tick < 52; tick++) {
        const [id, timer] = timers.entries().next().value;
        timers.delete(id);
        nowMs += timer.delay;
        await timer.callback();
      }
      assert.ok(seen.includes(ctx.attemptIds[0]),
        'an older due retry must not be starved by repeated incomplete checks');
      assert.ok(seen.includes(ctx.attemptIds[1]));
    } finally { await scheduler.stop(); }
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

test('unfinished claim retries after restart while a later attempt remains available', async () => {
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
      { state: 'reviewed', resolved: ctx.attemptIds.slice(0, 2), held: [] });
    assert.deepEqual(ctx.queue.listReviewNeeded({ nowMs: 1_004 }), []);
    assert.equal(ctx.queue.getResult(first.attemptId).reason, 'interrupted_retry');
    assert.equal(ctx.queue.claimNext({ nowMs: 1_004 }).attemptId, ctx.attemptIds[2]);
  });
});

test('session rejection retries on the next paced completion cycle', async () => {
  await fixture(async (ctx) => {
    const claim = ctx.queue.claimNext({ nowMs: 1_000 });
    ctx.queue.recordResult({ attemptId: claim.attemptId, pass: claim.pass,
      state: 'held', reason: 'provider_http_403', checkedMs: 1_001 });
    assert.equal(ctx.queue.getResult(claim.attemptId).nextDueMs, 61_001);
  });
});

test('an acknowledged stop gets a prompt stopped-state recheck', async () => {
  await fixture(async (ctx) => {
    const claim = ctx.queue.claimNext({ nowMs: 1_000 });
    ctx.queue.recordResult({ attemptId: claim.attemptId, pass: claim.pass,
      state: 'held', reason: 'torrent_not_stopped', checkedMs: 1_001 });
    assert.equal(ctx.queue.getResult(claim.attemptId).nextDueMs, 61_001);
  });
});

test('completion recovery reviews every page of interrupted attempts', async () => {
  await fixture(async (ctx) => {
    for (const attemptId of ctx.attemptIds) {
      assert.equal(ctx.queue.claimNext({ nowMs: 1_000 }).attemptId, attemptId);
    }
    ctx.reopen();
    assert.deepEqual(ctx.queue.reconcileUnresolved({ nowMs: 1_001, limit: 1 }),
      { state: 'reviewed', resolved: ctx.attemptIds, held: [] });
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
