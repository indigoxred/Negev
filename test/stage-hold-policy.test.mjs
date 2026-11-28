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

test('first-time provider outages remain due across repeated checks and restart', async () =>
  startFixture(async (ctx) => {
    const { collectTargetScopedUncertain } = await import('../src/acquisition/collect-target-scoped-uncertain.mjs');
    const first = ctx.ids[0].attemptId;
    let clock = 1000, restored = false;
    const processAttempt = async () => collectTargetScopedUncertain({
        anidbId: 42, episodeIds: [1001], kind: 'series', publicLibraryIds: [102],
        readEpisode: async target => restored ? { state: 'ok', files: [{}], ...target }
          : { state: 'unavailable' },
        probePublic: async () => { throw Error('must not pass the Shoko gate'); },
        now: () => clock,
      });
    const worker = createStartWorker({ queue: ctx.queue, now: () => clock, processAttempt });
    for (let turn = 0; turn < 4; turn++) {
      assert.equal((await worker.runOnce()).attemptId, first);
      const saved = ctx.queue.getResult(first);
      assert.equal(saved.reason, 'availability_unavailable');
      assert.ok(saved.nextDueMs > clock, 'an outage must retain a paced retry');
      clock = saved.nextDueMs;
    }
    ctx.reopen();
    restored = true;
    const reopenedWorker = createStartWorker({ queue: ctx.queue, now: () => clock, processAttempt });
    assert.equal((await reopenedWorker.runOnce()).attemptId, first);
    assert.equal(ctx.queue.getResult(first).reason, 'target_not_proven_unimported');
    assert.equal(ctx.queue.getResult(first).nextDueMs, null,
      'positive imported ownership after recovery is still held for review');
  }));

test('legacy ambiguous first-time holds get one logged recheck, not endless revival', async () =>
  startFixture(async (ctx) => {
    const raw = new DatabaseSync(ctx.dbPath);
    try {
      for (const [index, reason] of ['public_probe_unverified', 'target_not_proven_unimported'].entries()) {
        const claim = ctx.queue.claimNext({ nowMs: 1000 });
        assert.equal(claim.attemptId, ctx.ids[index].attemptId);
        ctx.queue.recordResult({ ...claim, state: 'held', reason, checkedMs: 1001 });
        raw.prepare('UPDATE start_checks SET version=2,next_due_ms=NULL WHERE attempt_id=?').run(claim.attemptId);
      }
      if (raw.prepare('PRAGMA table_info(start_checks)').all().some(c => c.name === 'first_time_policy_revision')) {
        raw.exec('UPDATE start_checks SET first_time_policy_revision=0');
      }
      ctx.reopen();
      const id = ctx.ids[0].attemptId;
      assert.equal(ctx.queue.getResult(id).nextDueMs, 61001);
      const claim = ctx.queue.claimNext({ nowMs: 61001 });
      assert.equal(claim.attemptId, id);
      ctx.queue.recordResult({ ...claim, state: 'held',
        reason: 'public_probe_unverified', checkedMs: 61002 });
      ctx.reopen();
      assert.equal(ctx.queue.getResult(id).nextDueMs, null,
        'a fresh contradictory observation must not be revived on every restart');
      assert.equal(raw.prepare("SELECT COUNT(*) n FROM stage_hold_policy_revivals WHERE reason IN ('public_probe_unverified','target_not_proven_unimported')").get().n, 2);
    } finally { raw.close(); }
  }));

test('an old parked selection mismatch gets one guarded recovery turn', async () =>
  startFixture(async ctx => {
    const claim = ctx.queue.claimNext({ nowMs: 1000 });
    ctx.queue.recordResult({ ...claim, state: 'held', reason: 'file_plan_mismatch', checkedMs: 1001 });
    const raw = new DatabaseSync(ctx.dbPath);
    try {
      raw.prepare('UPDATE start_checks SET version=2,next_due_ms=NULL WHERE attempt_id=?').run(claim.attemptId);
      if (raw.prepare('PRAGMA table_info(start_checks)').all().some(c => c.name === 'selection_policy_revision')) {
        raw.exec('UPDATE start_checks SET selection_policy_revision=0');
      }
      ctx.reopen();
      assert.equal(ctx.queue.getResult(claim.attemptId).nextDueMs, 61001);
      const retry = ctx.queue.claimNext({ nowMs: 61001 });
      assert.equal(retry.attemptId, claim.attemptId);
      ctx.queue.recordResult({ ...retry, state: 'held', reason: 'file_plan_mismatch', checkedMs: 61002 });
      ctx.reopen();
      assert.equal(ctx.queue.getResult(claim.attemptId).nextDueMs, null,
        'a current real mismatch remains held for review');
    } finally { raw.close(); }
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

test('publish retry caps count holds per reason, not every claim', async () =>
  publishFixture(async (ctx) => {
    let t = 1_000;
    const step = (reason) => {
      const c = ctx.queue.claimNext({ nowMs: t });
      assert.equal(c.attemptId, ctx.attemptId);
      ctx.queue.recordResult({ ...c, state: 'held', reason, checkedMs: t });
      const due = ctx.queue.getResult(ctx.attemptId).nextDueMs;
      if (due !== null) t = due;
      return due;
    };
    // Several preflight mount waits no longer use up the single
    // identity retry, so the first identity failure still retries…
    for (let i = 0; i < 4; i++) assert.notEqual(step('handoff_mount_unavailable'), null);
    assert.notEqual(step('identity_unavailable'), null);
    // …and a mount wait in between does not grant a second rehash.
    assert.notEqual(step('handoff_mount_unavailable'), null);
    assert.equal(step('identity_unavailable'), null);
  }));

const parkStart = (ctx, reason = 'file_plan_mismatch') => {
  const first = ctx.queue.claimNext({ nowMs: 1_000 });
  ctx.queue.recordResult({ ...first, state: 'held', reason: 'provider_unavailable', checkedMs: 1_001 });
  const second = ctx.queue.claimNext({ nowMs: 61_001 });
  ctx.queue.recordResult({ ...second, state: 'held', reason, checkedMs: 61_002 });
  assert.equal(ctx.queue.getResult(first.attemptId).nextDueMs, null);
  return first.attemptId;
};

test('admin retry makes only a parked start check due now and logs it', async () =>
  startFixture(async (ctx) => {
    const attemptId = parkStart(ctx);
    assert.deepEqual(ctx.queue.retryReview({ attemptId: ctx.ids[1].attemptId,
      actorId: 1, nowMs: 70_000 }), { state: 'held', reason: 'not_in_review' });
    assert.deepEqual(ctx.queue.retryReview({ attemptId, actorId: 1, nowMs: 70_000 }),
      { state: 'retry_scheduled', version: 2 });
    assert.equal(ctx.queue.getResult(attemptId).nextDueMs, 70_000);
    assert.equal(ctx.queue.claimNext({ nowMs: 70_000 }).attemptId, attemptId);
    const raw = new DatabaseSync(ctx.dbPath);
    assert.deepEqual({ ...raw.prepare(`SELECT stage,attempt_id AS attemptId,check_version AS v,
      action,reason,actor_id AS actor FROM operator_review_actions`).get() },
    { stage: 'start', attemptId, v: 2, action: 'retry', reason: 'file_plan_mismatch', actor: 1 });
    raw.close();
  }));

test('admin release retires a parked never-started attempt as a policy reset and frees its episodes', async () =>
  startFixture(async (ctx) => {
    const attemptId = parkStart(ctx);
    const { hash } = ctx.ids[0];
    // Without a recorded release the guarded retirement still refuses.
    assert.deepEqual(ctx.acquisitions.requestPrestartMismatchRetirement({
      attemptId, hash, nowMs: 70_000 }), { state: 'held', reason: 'mismatch_not_recorded' });
    assert.equal(ctx.queue.recordReleaseRequest({ attemptId, actorId: 1, nowMs: 70_001 }).state,
      'release_recorded');
    assert.equal(ctx.acquisitions.requestPrestartMismatchRetirement({
      attemptId, hash, nowMs: 70_002 }).state, 'retirement_requested');
    // A retry cannot race an in-progress release.
    assert.equal(ctx.queue.retryReview({ attemptId, actorId: 1, nowMs: 70_003 }).reason,
      'not_in_review');
    assert.equal(ctx.acquisitions.beginPrestartMismatchDelete({
      attemptId, hash, nowMs: 70_004 }).state, 'delete_unknown');
    assert.equal(ctx.acquisitions.retirePrestartMismatch({
      attemptId, hash, nowMs: 70_005 }).state, 'retired_prestart_mismatch');
    const raw = new DatabaseSync(ctx.dbPath);
    assert.equal(raw.prepare('SELECT reason FROM acquisition_retirements WHERE attempt_id=?')
      .get(attemptId).reason, 'policy_reset');
    raw.close();
    const other = ctx.acquisitions.reserve({ requestId: 1,
      candidate: { indexerId: 7, guid: 'replacement' }, episodeIds: [1001], nowMs: 80_000 });
    assert.equal(other.state, 'reserved');
  }));

test('a wrong-installment prestart retirement keeps its wrong-identity reason', async () =>
  startFixture(async (ctx) => {
    const attemptId = parkStart(ctx, 'related_installment_mismatch');
    const { hash } = ctx.ids[0];
    ctx.acquisitions.requestPrestartMismatchRetirement({ attemptId, hash, nowMs: 70_000 });
    ctx.acquisitions.beginPrestartMismatchDelete({ attemptId, hash, nowMs: 70_001 });
    assert.equal(ctx.acquisitions.retirePrestartMismatch({ attemptId, hash, nowMs: 70_002 }).state,
      'retired_prestart_mismatch');
    const raw = new DatabaseSync(ctx.dbPath);
    assert.equal(raw.prepare('SELECT reason FROM acquisition_retirements WHERE attempt_id=?')
      .get(attemptId).reason, 'file_wrong_identity');
    raw.close();
  }));

test('admin retry on a parked import makes it due now', async () =>
  publishFixture(async (ctx) => {
    const c = ctx.queue.claimNext({ nowMs: 1_000 });
    ctx.queue.recordResult({ ...c, state: 'held', reason: 'manifest_tree_mismatch', checkedMs: 1_001 });
    assert.equal(ctx.queue.retryReview({ attemptId: ctx.attemptId, actorId: 1, nowMs: 5_000 }).state,
      'retry_scheduled');
    assert.equal(ctx.queue.claimNext({ nowMs: 5_000 }).attemptId, ctx.attemptId);
  }));
