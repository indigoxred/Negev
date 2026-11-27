import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { openAcquisitionLedger } from '../src/acquisition/acquisition-ledger.mjs';
import { openAcquisitionRequestQueue } from '../src/acquisition/acquisition-request-queue.mjs';
import { openStartQueue, createStartWorker } from '../src/acquisition/start-queue.mjs';
import { openHandoffLedger } from '../src/acquisition/handoff-ledger.mjs';
import { evaluateHandoffEvidence } from '../src/acquisition/handoff-evidence.mjs';
import { openHandoffPublishQueue } from '../src/acquisition/handoff-publish-queue.mjs';
import { transientRetryDelayMs } from '../src/acquisition/stage-hold-policy.mjs';

const MIN = 60_000;

async function startFixture(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-hold-policy-'));
  const dbPath = path.join(root, 'state.sqlite');
  const requests = openRequestLedger(dbPath);
  const request = requests.submit({ requesterId: 1, requestKey: 'policy', nowMs: 100,
    intent: { state: 'ready', anidbId: 42, kind: 'series',
      monitorFuture: false, episodeIds: [1001, 1002] } });
  const acquisitions = openAcquisitionLedger(dbPath);
  openAcquisitionRequestQueue(dbPath).close();
  const ids = [];
  for (let i = 0; i < 2; i++) {
    const candidate = { indexerId: 7, guid: `policy-${i}` };
    const hash = String(i + 1).repeat(40);
    const { attemptId } = acquisitions.reserve({ requestId: request.requestId,
      candidate, episodeIds: [1001 + i], nowMs: 200 + i * 10 });
    acquisitions.bindPreparedTorrent({ attemptId, candidate, hash, nowMs: 201 + i * 10 });
    acquisitions.recordFilePlan({ attemptId, hash, plannedFiles: [{ name: `${i}.mkv`,
      size: 10, episodeIds: [1001 + i] }], nowMs: 202 + i * 10 });
    acquisitions.beginDispatch({ attemptId, nowMs: 203 + i * 10 });
    acquisitions.recordTorrent({ attemptId, hash, nowMs: 204 + i * 10 });
    ids.push({ attemptId, hash });
  }
  let queue = openStartQueue(dbPath);
  try {
    await run({ dbPath, ids, acquisitions, get queue() { return queue; },
      reopen() { queue.close(); queue = openStartQueue(dbPath); } });
  } finally {
    queue.close(); acquisitions.close(); requests.close();
    await rm(root, { recursive: true, force: true });
  }
}

test('transient retry delay backs off and never ends', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 50].map(transientRetryDelayMs),
    [30 * MIN, 60 * MIN, 120 * MIN, 240 * MIN, 360 * MIN, 360 * MIN, 360 * MIN]);
  assert.equal(transientRetryDelayMs(undefined), 30 * MIN);
});

test('a transient start hold after a session retry keeps retrying instead of review', async () =>
  startFixture(async (ctx) => {
    let t = 1_000;
    const reasons = ['provider_unavailable', 'availability_unavailable',
      'staging_root_unverified', 'sonarr_ownership_unavailable', 'worker_unavailable'];
    const worker = createStartWorker({ queue: ctx.queue, now: () => t,
      processAttempt: async ({ attemptId }) => attemptId === ctx.ids[0].attemptId
        ? { state: 'held', reason: reasons.shift() }
        : { state: 'held', reason: 'file_plan_mismatch' } });
    const first = ctx.ids[0].attemptId;
    await worker.runOnce(); // attempt 1: provider_unavailable (60 s)
    await worker.runOnce(); // attempt 2: decisive mismatch (one 30 min retry)
    for (let claim = 2; claim <= 5; claim++) {
      t = ctx.queue.getResult(first).nextDueMs;
      assert.equal((await worker.runOnce()).attemptId, first);
      const saved = ctx.queue.getResult(first);
      assert.equal(saved.version, claim);
      assert.equal(saved.nextDueMs, t + transientRetryDelayMs(claim),
        `${saved.reason} must back off, not stop`);
    }
    assert.deepEqual(ctx.queue.listReviewNeeded().map((row) => row.attemptId), []);
  }));

test('decisive start evidence still reaches review after its single retry', async () =>
  startFixture(async (ctx) => {
    const first = ctx.queue.claimNext({ nowMs: 1_000 });
    ctx.queue.recordResult({ ...first, state: 'held', reason: 'provider_unavailable', checkedMs: 1_001 });
    const second = ctx.queue.claimNext({ nowMs: 61_001 });
    assert.equal(second.attemptId, first.attemptId);
    ctx.queue.recordResult({ ...second, state: 'held', reason: 'file_plan_mismatch', checkedMs: 61_002 });
    assert.equal(ctx.queue.getResult(first.attemptId).nextDueMs, null);
    assert.deepEqual(ctx.queue.listReviewNeeded().map((row) => row.reason), ['file_plan_mismatch']);
  }));

test('legacy parked transient start holds are revived once, logged and exactly reversible', async () =>
  startFixture(async (ctx) => {
    const [a, b] = ctx.ids.map((row) => row.attemptId);
    for (const id of [a, b]) {
      const claim = ctx.queue.claimNext({ nowMs: 1_000 });
      assert.equal(claim.attemptId, id);
      ctx.queue.recordResult({ ...claim, state: 'held', reason: 'file_plan_mismatch', checkedMs: 1_001 });
    }
    // Simulate rows an earlier build parked: one transient, one decisive,
    // and one transient row whose start intent already exists.
    const raw = new DatabaseSync(ctx.dbPath);
    raw.exec(`UPDATE start_checks SET reason='availability_unavailable',next_due_ms=NULL,version=2 WHERE attempt_id=${a};
      UPDATE start_checks SET next_due_ms=NULL,version=2 WHERE attempt_id=${b}`);
    ctx.reopen();
    assert.equal(ctx.queue.getResult(a).nextDueMs, 1_001 + MIN);
    assert.equal(ctx.queue.getResult(b).nextDueMs, null, 'decisive evidence is untouched');
    const log = raw.prepare('SELECT stage,attempt_id AS attemptId,version,reason,checked_ms AS checkedMs FROM stage_hold_policy_revivals').all()
      .map((row) => ({ ...row }));
    assert.deepEqual(log, [{ stage: 'start', attemptId: a, version: 2,
      reason: 'availability_unavailable', checkedMs: 1_001 }]);
    ctx.reopen();
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM stage_hold_policy_revivals').get().n, 1,
      'reopening does not log or revive again');
    // The documented undo restores the previous terminal review exactly.
    raw.exec(`UPDATE start_checks SET next_due_ms=NULL WHERE state='held' AND EXISTS (
      SELECT 1 FROM stage_hold_policy_revivals v WHERE v.stage='start'
        AND v.attempt_id=start_checks.attempt_id AND v.version=start_checks.version)`);
    assert.equal(ctx.queue.getResult(a).nextDueMs, null);
    raw.close();
  }));

test('a transient start hold with a saved start intent is not revived', async () =>
  startFixture(async (ctx) => {
    const { attemptId, hash } = ctx.ids[0];
    const claim = ctx.queue.claimNext({ nowMs: 1_000 });
    ctx.queue.recordResult({ ...claim, state: 'held', reason: 'file_plan_mismatch', checkedMs: 1_001 });
    ctx.acquisitions.beginStart({ attemptId, hash, manifestDigest: 'c'.repeat(64), nowMs: 1_002 });
    const raw = new DatabaseSync(ctx.dbPath);
    raw.exec(`UPDATE start_checks SET reason='worker_unavailable',next_due_ms=NULL WHERE attempt_id=${attemptId}`);
    ctx.reopen();
    assert.equal(ctx.queue.getResult(attemptId).nextDueMs, null);
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM stage_hold_policy_revivals').get().n, 0);
    raw.close();
  }));

async function publishFixture(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-hold-publish-'));
  const dbPath = path.join(root, 'state.sqlite');
  const requests = openRequestLedger(dbPath);
  const request = requests.submit({ requesterId: 1, requestKey: 'publish', nowMs: 100,
    intent: { state: 'ready', anidbId: 42, kind: 'series',
      monitorFuture: false, episodeIds: [1001] } });
  const acquisitions = openAcquisitionLedger(dbPath);
  openAcquisitionRequestQueue(dbPath).close();
  const handoffs = openHandoffLedger(dbPath);
  const candidate = { indexerId: 7, guid: 'publish' };
  const hash = '1'.repeat(40);
  const { attemptId } = acquisitions.reserve({ requestId: request.requestId, candidate,
    episodeIds: [1001], nowMs: 200 });
  acquisitions.bindPreparedTorrent({ attemptId, candidate, hash, nowMs: 201 });
  acquisitions.recordFilePlan({ attemptId, hash, plannedFiles: [{ name: '1.mkv',
    size: 10, episodeIds: [1001] }], nowMs: 202 });
  acquisitions.beginDispatch({ attemptId, nowMs: 203 });
  acquisitions.recordTorrent({ attemptId, hash, nowMs: 204 });
  acquisitions.beginStart({ attemptId, hash, manifestDigest: 'b'.repeat(64), nowMs: 205 });
  const batch = { anidbId: 42, torrentHash: hash, files: [{ name: '1.mkv', size: 10,
    ed2k: 'A'.repeat(32), anidbFileId: 51, episodeIds: [1001] }], subtitles: [] };
  handoffs.recordPrepared({ attemptId, prepared: { ...batch, state: 'handoff_prepared',
    publishReady: false, holdingPath: path.join(root, 'holding'),
    evidenceDigest: evaluateHandoffEvidence(batch).digest }, nowMs: 206 });
  let queue = openHandoffPublishQueue(dbPath);
  try {
    await run({ dbPath, attemptId, get queue() { return queue; },
      reopen() { queue.close(); queue = openHandoffPublishQueue(dbPath); } });
  } finally {
    queue.close(); handoffs.close(); acquisitions.close(); requests.close();
    await rm(root, { recursive: true, force: true });
  }
}

test('an unverified staging root at publish keeps a paced preflight retry', async () =>
  publishFixture(async (ctx) => {
    let t = 1_000;
    for (let claim = 1; claim <= 3; claim++) {
      const c = ctx.queue.claimNext({ nowMs: t });
      assert.equal(c.attemptId, ctx.attemptId);
      ctx.queue.recordResult({ ...c, state: 'held', reason: 'staging_root_unverified', checkedMs: t });
      assert.equal(ctx.queue.getResult(ctx.attemptId).nextDueMs, t + 5 * MIN);
      t += 5 * MIN;
    }
    assert.deepEqual(ctx.queue.listReviewNeeded(), []);
  }));

test('legacy parked publish staging holds are revived and logged', async () =>
  publishFixture(async (ctx) => {
    const c = ctx.queue.claimNext({ nowMs: 1_000 });
    ctx.queue.recordResult({ ...c, state: 'held', reason: 'staging_root_unverified', checkedMs: 1_001 });
    const raw = new DatabaseSync(ctx.dbPath);
    raw.exec(`UPDATE handoff_publish_checks SET next_due_ms=NULL WHERE attempt_id=${ctx.attemptId}`);
    ctx.reopen();
    assert.equal(ctx.queue.getResult(ctx.attemptId).nextDueMs, 1_001 + MIN);
    assert.deepEqual(raw.prepare('SELECT stage,reason FROM stage_hold_policy_revivals').all()
      .map((row) => ({ ...row })), [{ stage: 'publish', reason: 'staging_root_unverified' }]);
    raw.close();
  }));
