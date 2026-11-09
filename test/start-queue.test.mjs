import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { openAcquisitionLedger } from '../src/acquisition/acquisition-ledger.mjs';
import { openAcquisitionRequestQueue } from '../src/acquisition/acquisition-request-queue.mjs';
import { openStartQueue, createStartWorker } from '../src/acquisition/start-queue.mjs';
import { processRecordedStart } from '../src/acquisition/process-recorded-start.mjs';

async function fixture(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-start-queue-'));
  const dbPath = path.join(root, 'state.sqlite');
  const requests = openRequestLedger(dbPath);
  const request = requests.submit({ requesterId: 1, requestKey: 'start', nowMs: 100,
    intent: { state: 'ready', anidbId: 42, kind: 'series',
      monitorFuture: false, episodeIds: [1001, 1002, 1003] } });
  const acquisitions = openAcquisitionLedger(dbPath);
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const candidate = { indexerId: 7, guid: `start-${i}` };
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
    ids.push({ attemptId, hash });
  }
  let queue = openStartQueue(dbPath);
  try {
    await run({ dbPath, ids, requests, acquisitions,
      get queue() { return queue; },
      reopen() { queue.close(); queue = openStartQueue(dbPath); } });
  } finally {
    queue.close(); acquisitions.close(); requests.close();
    await rm(root, { recursive: true, force: true });
  }
}

test('one stopped torrent holds while later stopped torrents advance', async () =>
  fixture(async (ctx) => {
    const worker = createStartWorker({ queue: ctx.queue, now: () => 1_000,
      processAttempt: async () => ({ state: 'held', reason: 'mount_evidence_unavailable' }) });
    for (const row of ctx.ids) {
      const result = await worker.runOnce();
      assert.equal(result.attemptId, row.attemptId);
    }
    assert.deepEqual(await worker.runOnce(), { state: 'idle' });
    assert.equal(ctx.queue.getResult(ctx.ids[0].attemptId).nextDueMs, 1_801_000);
    ctx.reopen();
    assert.equal(ctx.queue.claimNext({ nowMs: 1_800_999 }).state, 'idle');
    assert.equal(ctx.queue.claimNext({ nowMs: 1_801_000 }).attemptId,
      ctx.ids[0].attemptId);
  }));

test('cutover hold excludes saved starts until explicit resume', async () =>
  fixture(async (ctx) => {
    const later = ctx.requests.submit({ requesterId: 1,
      requestKey: 'later-start', nowMs: 800,
      intent: { state: 'ready', anidbId: 43, kind: 'series',
        monitorFuture: false, episodeIds: [2001] } });
    const candidate = { indexerId: 7, guid: 'later-start' };
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
        ctx.ids[0].attemptId);
    } finally { holds.close(); }
  }));

test('cutover hold refuses an unfinished start claim', async () =>
  fixture(async (ctx) => {
    const holds = openAcquisitionRequestQueue(ctx.dbPath);
    try {
      const active = ctx.queue.claimNext({ nowMs: 1_000 });
      assert.equal(active.attemptId, ctx.ids[0].attemptId);
      assert.deepEqual(holds.suspendForCutover({ requestId: 1,
        reason: 'cutover_review', nowMs: 1_001 }),
      { state: 'held', reason: 'request_inflight' });
      assert.equal(holds.getSuspension(1), null);
      assert.deepEqual(ctx.queue.recordResult({ attemptId: active.attemptId,
        version: active.version, state: 'held',
        reason: 'mount_evidence_unavailable', checkedMs: 1_002 }),
      { state: 'recorded' });
      assert.deepEqual(holds.suspendForCutover({ requestId: 1,
        reason: 'cutover_review', nowMs: 1_003 }), { state: 'suspended' });
    } finally { holds.close(); }
  }));

test('a prestart retirement intent removes that attempt from start retries', async () =>
  fixture(async (ctx) => {
    const first = ctx.queue.claimNext({ nowMs: 1_000 });
    ctx.queue.recordResult({ attemptId: first.attemptId,
      version: first.version, state: 'held',
      reason: 'related_installment_mismatch', checkedMs: 1_001 });
    const { attemptId, hash } = ctx.ids[0];
    assert.equal(ctx.acquisitions.requestPrestartMismatchRetirement({
      attemptId, hash, nowMs: 1_002 }).state, 'retirement_requested');
    assert.equal(ctx.queue.claimNext({ nowMs: 1_801_001 }).attemptId,
      ctx.ids[1].attemptId);
  }));

test('a saved uncertain add is selected for exact stopped-torrent recovery', async () =>
  fixture(async (ctx) => {
    const request = ctx.requests.submit({ requesterId: 1,
      requestKey: 'unknown-dispatch', nowMs: 100,
      intent: { state: 'ready', anidbId: 43, kind: 'series',
        monitorFuture: false, episodeIds: [2001] } });
    const candidate = { indexerId: 7, guid: 'unknown-dispatch' };
    const hash = 'f'.repeat(40);
    const attemptId = ctx.acquisitions.reserve({ requestId: request.requestId,
      candidate, episodeIds: [2001], nowMs: 200 }).attemptId;
    ctx.acquisitions.bindPreparedTorrent({ attemptId, candidate, hash, nowMs: 201 });
    ctx.acquisitions.recordFilePlan({ attemptId, hash,
      plannedFiles: [{ name: '01.mkv', size: 10, episodeIds: [2001] }], nowMs: 202 });
    ctx.acquisitions.beginDispatch({ attemptId, nowMs: 203 });
    for (const row of ctx.ids) assert.equal(ctx.queue.claimNext({ nowMs: 1_000 })
      .attemptId, row.attemptId);
    assert.equal(ctx.queue.claimNext({ nowMs: 1_000 }).attemptId, attemptId);
  }));

test('a saved start intent is never selected for a second start', async () =>
  fixture(async (ctx) => {
    const first = ctx.queue.claimNext({ nowMs: 1_000 });
    const row = ctx.ids[0];
    assert.equal(ctx.acquisitions.beginStart({ attemptId: row.attemptId,
      hash: row.hash, manifestDigest: 'a'.repeat(64), nowMs: 1_001 }).state,
    'start_unknown');
    assert.deepEqual(ctx.queue.recordResult({ attemptId: first.attemptId,
      version: first.version, state: 'start_unknown', checkedMs: 1_002 }),
    { state: 'recorded' });
    ctx.reopen();
    assert.equal(ctx.queue.claimNext({ nowMs: 10_000_000 }).attemptId,
      ctx.ids[1].attemptId);
  }));

test('an interrupted claim reconciles from the durable start intent', async () =>
  fixture(async (ctx) => {
    const first = ctx.queue.claimNext({ nowMs: 1_000 });
    ctx.acquisitions.beginStart({ attemptId: first.attemptId,
      hash: ctx.ids[0].hash, manifestDigest: 'a'.repeat(64), nowMs: 1_001 });
    ctx.reopen();
    assert.deepEqual(ctx.queue.reconcileUnresolved({ nowMs: 1_002 }),
      { state: 'reviewed', resolved: [first.attemptId], held: [] });
    assert.equal(ctx.queue.getResult(first.attemptId).state, 'start_unknown');
    assert.equal(ctx.queue.claimNext({ nowMs: 10_000_000 }).attemptId,
      ctx.ids[1].attemptId);
  }));

test('an interrupted pre-intent claim retries later without blocking others', async () =>
  fixture(async (ctx) => {
    const first = ctx.queue.claimNext({ nowMs: 1_000 });
    ctx.reopen();
    assert.deepEqual(ctx.queue.reconcileUnresolved({ nowMs: 1_001 }),
      { state: 'reviewed', resolved: [first.attemptId], held: [] });
    assert.equal(ctx.queue.getResult(first.attemptId).nextDueMs, 301_001);
    assert.equal(ctx.queue.claimNext({ nowMs: 1_001 }).attemptId, ctx.ids[1].attemptId);
  }));

test('start recovery reviews every page before declaring reconciliation complete', async () =>
  fixture(async (ctx) => {
    for (const row of ctx.ids) assert.equal(ctx.queue.claimNext({ nowMs: 1_000 })
      .attemptId, row.attemptId);
    ctx.reopen();
    assert.deepEqual(ctx.queue.reconcileUnresolved({ nowMs: 1_001, limit: 1 }),
      { state: 'reviewed', resolved: ctx.ids.map((row) => row.attemptId),
        held: [] });
  }));

test('a second queue connection cannot claim the same stopped attempt', async () =>
  fixture(async (ctx) => {
    const other = openStartQueue(ctx.dbPath);
    try {
      const first = ctx.queue.claimNext({ nowMs: 1_000 });
      const second = other.claimNext({ nowMs: 1_000 });
      assert.equal(first.attemptId, ctx.ids[0].attemptId);
      assert.equal(second.attemptId, ctx.ids[1].attemptId);
    } finally { other.close(); }
  }));

test('a repeated unavailable start goes to review rather than polling forever', async () =>
  fixture(async (ctx) => {
    const first = ctx.queue.claimNext({ nowMs: 1_000 });
    assert.equal(ctx.queue.recordResult({ attemptId: first.attemptId,
      version: first.version, state: 'held', reason: 'provider_unavailable',
      checkedMs: 1_001 }).state, 'recorded');
    const second = ctx.queue.claimNext({ nowMs: 1_801_001 });
    assert.equal(second.attemptId, first.attemptId);
    assert.equal(ctx.queue.recordResult({ attemptId: second.attemptId,
      version: second.version, state: 'held', reason: 'provider_unavailable',
      checkedMs: 1_801_002 }).state, 'recorded');
    assert.equal(ctx.queue.getResult(first.attemptId).nextDueMs, null);
    assert.deepEqual(ctx.queue.listReviewNeeded(), [{
      attemptId: first.attemptId, reason: 'provider_unavailable',
      checkedMs: 1_801_002,
    }]);
    assert.equal(ctx.queue.claimNext({ nowMs: 10_000_000 }).attemptId,
      ctx.ids[1].attemptId);
  }));

test('journalled start processor and queue issue only one start intent', async () =>
  fixture(async (ctx) => {
    let sends = 0;
    const worker = createStartWorker({ queue: ctx.queue, now: () => 1_000,
      processAttempt: ({ attemptId }) => processRecordedStart({
        attemptId, requests: ctx.requests, acquisitions: ctx.acquisitions,
        stagingHostPath: '/srv/staging',
        qbittorrent: { baseUrl: 'http://qbit.local/', sessionId: 'sid' },
        inspectMounts: async () => ({}), realpathImpl: async () => '/srv/staging',
        readEvidence: async () => ({}), publicLibraryIds: [102],
        start: async ({ ledger, attemptId: id, expected }) => {
          const intent = ledger.beginStart({ attemptId: id, hash: expected.hash,
            manifestDigest: 'a'.repeat(64), nowMs: 1_000 });
          if (intent.sendNow) sends++;
          return intent;
        },
      }) });
    assert.equal((await worker.runOnce()).result.state, 'start_unknown');
    ctx.reopen();
    const restarted = createStartWorker({ queue: ctx.queue, now: () => 10_000_000,
      processAttempt: async () => { throw new Error('should not replay first'); } });
    assert.equal((await restarted.runOnce()).attemptId, ctx.ids[1].attemptId);
    assert.equal(sends, 1);
    assert.equal(ctx.queue.getResult(ctx.ids[0].attemptId).state, 'start_unknown');
  }));
