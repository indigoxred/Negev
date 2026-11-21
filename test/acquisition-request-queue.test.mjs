import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { openAcquisitionLedger } from '../src/acquisition/acquisition-ledger.mjs';
import { openAcquisitionRequestQueue, createAcquisitionPageWorker,
  reconcileUnresolvedAcquisitionClaims } from
  '../src/acquisition/acquisition-request-queue.mjs';


test('a newly chosen release bypasses only the previous empty-search delay, once across restart',
  async () => fixture(async dbPath => {
    let queue = openAcquisitionRequestQueue(dbPath);
    const db = new DatabaseSync(dbPath);
    const select = revision => db.prepare('UPDATE requests SET release_control=? WHERE id=1')
      .run(JSON.stringify({mode:'manual',phase:'chosen',revision}));
    try {
      const first = queue.claimNext({nowMs:100,priorityRequestId:1});
      queue.recordResult({requestId:1,pass:first.pass,state:'held',reason:'no_safe_release',checkedMs:100});
      assert.notEqual(queue.claimNext({nowMs:101,priorityRequestId:1}).requestId,1);
      select(2);
      queue.close(); queue = openAcquisitionRequestQueue(dbPath);
      const chosen = queue.claimNext({nowMs:102,priorityRequestId:1});
      assert.equal(chosen.requestId,1);
      assert.notEqual(queue.claimNext({nowMs:103,priorityRequestId:1}).requestId,1);
      queue.recordResult({requestId:1,pass:chosen.pass,state:'held',reason:'no_safe_release',checkedMs:104});
      assert.notEqual(queue.claimNext({nowMs:105,priorityRequestId:1}).requestId,1);
      select(3);
      assert.equal(queue.claimNext({nowMs:106,priorityRequestId:1}).requestId,1);
    } finally {db.close();queue.close();}
  }));

test('a choice saved during an active search survives that search recording an empty result',
  async () => fixture(async dbPath => {
    const queue = openAcquisitionRequestQueue(dbPath);
    const db = new DatabaseSync(dbPath);
    try {
      const first = queue.claimNext({nowMs:100,priorityRequestId:1});
      db.prepare('UPDATE requests SET release_control=? WHERE id=1').run(
        JSON.stringify({mode:'auto',phase:'chosen',revision:2}));
      assert.notEqual(queue.claimNext({nowMs:101,priorityRequestId:1}).requestId,1);
      queue.recordResult({requestId:1,pass:first.pass,state:'held',reason:'no_release_candidates',checkedMs:102});
      assert.equal(queue.claimNext({nowMs:103,priorityRequestId:1}).requestId,1);
    } finally {db.close();queue.close();}
  }));

for(const reason of ['preferred_group_wait','shoko_metadata_missing','import_activity_unverified']) {
  test('a new release choice does not bypass '+reason,async()=>fixture(async dbPath=>{
    const queue=openAcquisitionRequestQueue(dbPath);const db=new DatabaseSync(dbPath);
    try{
      const claim=queue.claimNext({nowMs:100,priorityRequestId:1});
      queue.recordResult({requestId:1,pass:claim.pass,state:'held',reason,checkedMs:100,
        ...(reason==='preferred_group_wait'?{retryAtMs:7_200_100}:{})});
      db.prepare('UPDATE requests SET release_control=? WHERE id=1').run(
        JSON.stringify({mode:'manual',phase:'chosen',revision:2}));
      assert.notEqual(queue.claimNext({nowMs:101,priorityRequestId:1}).requestId,1);
    }finally{db.close();queue.close();}
  }));
}

const intent = { state: 'ready', anidbId: 42, kind: 'series',
  episodeIds: [1001], monitorFuture: false };

test('a preferred-group expiry is scheduled durably without another RSS event',async()=>fixture(async dbPath=>{
 let queue=openAcquisitionRequestQueue(dbPath);
 try{
   const claim=queue.claimNext({nowMs:100});
   queue.recordResult({requestId:claim.requestId,pass:claim.pass,state:'held',reason:'preferred_group_wait',retryAtMs:7_200_100,checkedMs:100});
   assert.equal(queue.getResult(1).nextDueMs,7_200_100);queue.close();queue=openAcquisitionRequestQueue(dbPath);
   assert.ok(queue.listMetadataRetries({nowMs:100}).some(row=>row.requestId===1&&row.nextDueMs===7_200_100));
   assert.notEqual(queue.claimNext({nowMs:101,priorityRequestId:1}).requestId,1);
   assert.equal(queue.claimNext({nowMs:7_200_100,priorityRequestId:1}).requestId,1);
 }finally{queue.close();}
}));

test('a recent multi-episode empty search is revisited once under a new query policy', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-search-policy-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const ledger = openRequestLedger(dbPath);
  const nowMs = Date.now();
  ledger.submit({ requesterId: 1, requestKey: 'multi', nowMs,
    intent: { ...intent, episodeIds: [1001, 1002, 1003],
      monitorFuture: true } });
  ledger.close();
  let queue = openAcquisitionRequestQueue(dbPath);
  try {
    const claim = queue.claimNext({ nowMs });
    queue.recordResult({ requestId: 1, pass: claim.pass, state: 'held',
      reason: 'no_safe_release', checkedMs: nowMs });
    assert.equal(queue.getResult(1).nextDueMs, nowMs + 3_600_000);
    queue.close();
    queue = openAcquisitionRequestQueue(dbPath);
    assert.ok(queue.getResult(1).nextDueMs <= nowMs + 70_000);
    assert.deepEqual(queue.listMetadataRetries({ nowMs }),
      [{ requestId: 1, nextDueMs: queue.getResult(1).nextDueMs }]);
    const revisit = queue.claimNext({ nowMs: nowMs + 70_000,
      priorityRequestId: 1 });
    assert.equal(revisit.requestId, 1);
    queue.recordResult({ requestId: 1, pass: revisit.pass, state: 'held',
      reason: 'no_safe_release', checkedMs: nowMs + 70_000 });
    assert.equal(queue.getResult(1).nextDueMs, nowMs + 70_000 + 3_600_000);
    queue.close();
    queue = openAcquisitionRequestQueue(dbPath);
    assert.equal(queue.getResult(1).nextDueMs, nowMs + 70_000 + 3_600_000);
  } finally {
    queue.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('an interrupted watch resumes only when every saved attempt is observed and scoped',
  async () => fixture(async (dbPath) => {
    const acquisitions = openAcquisitionLedger(dbPath);
    const queue = openAcquisitionRequestQueue(dbPath);
    const db = new DatabaseSync(dbPath);
    try {
      const claim = queue.claimNext({ nowMs: 100 });
      queue.recordResult({ requestId: 1, pass: claim.pass, state: 'held',
        reason: 'interrupted_attempt_present', checkedMs: 100 });
      assert.deepEqual(queue.resumeObservedAttemptHolds({ nowMs: 200 }), []);
      db.prepare(`INSERT INTO acquisition_attempts
        (request_id,anidb_id,indexer_id,candidate_digest,status,created_ms,updated_ms)
        VALUES (1,41,5,'first','reserved',1,1)`).run();
      db.prepare(`INSERT INTO acquisition_target_claims
        (attempt_id,anidb_id,episode_id) VALUES (1,41,1001)`).run();
      assert.deepEqual(queue.resumeObservedAttemptHolds({ nowMs: 200 }), []);
      db.prepare(`UPDATE acquisition_attempts SET status='torrent_observed',
        torrent_hash=? WHERE id=1`).run('a'.repeat(40));
      assert.deepEqual(queue.resumeObservedAttemptHolds({ nowMs: 200 }), [1]);
      assert.equal(queue.getResult(1).nextDueMs, 200);
      assert.deepEqual(queue.resumeObservedAttemptHolds({ nowMs: 199 }), []);
      assert.deepEqual(queue.resumeObservedAttemptHolds({ nowMs: 260 }), [1]);
      assert.equal(queue.getResult(1).nextDueMs, 200);
      assert.equal(queue.claimNext({ nowMs: 200, priorityRequestId: 1 }).requestId, 1);
      assert.deepEqual(queue.resumeObservedAttemptHolds({ nowMs: 201 }), []);
    } finally { db.close(); queue.close(); acquisitions.close(); }
  }));

test('an interrupted watch ignores retired attempts while guarding current attempts',
  async () => fixture(async (dbPath) => {
    const acquisitions = openAcquisitionLedger(dbPath);
    const queue = openAcquisitionRequestQueue(dbPath);
    const db = new DatabaseSync(dbPath);
    try {
      const claim = queue.claimNext({ nowMs: 100 });
      queue.recordResult({ requestId: 1, pass: claim.pass, state: 'held',
        reason: 'interrupted_attempt_present', checkedMs: 100 });
      const insert = db.prepare(`INSERT INTO acquisition_attempts
        (request_id,anidb_id,indexer_id,candidate_digest,status,
          torrent_hash,created_ms,updated_ms)
        VALUES (1,41,5,?,'torrent_observed',?,1,1)`);
      const oldHash = 'a'.repeat(40);
      const currentHash = 'b'.repeat(40);
      const oldId = Number(insert.run('old', oldHash).lastInsertRowid);
      const currentId = Number(insert.run('current', currentHash).lastInsertRowid);
      db.prepare(`INSERT INTO acquisition_target_claims
        (attempt_id,anidb_id,episode_id,active)
        VALUES (?,41,1001,0)`).run(oldId);
      db.prepare(`INSERT INTO acquisition_target_claims
        (attempt_id,anidb_id,episode_id,active)
        VALUES (?,41,1001,1)`).run(currentId);
      assert.deepEqual(queue.resumeObservedAttemptHolds({ nowMs: 200 }), []);
      db.prepare(`INSERT INTO acquisition_retirements
        (attempt_id,torrent_hash,reason,retired_ms)
        VALUES (?,?,'policy_reset',150)`).run(oldId, oldHash);
      assert.deepEqual(queue.resumeObservedAttemptHolds({ nowMs: 200 }), [1]);
      assert.equal(queue.claimNext({ nowMs: 200, priorityRequestId: 1 }).requestId, 1);
    } finally { db.close(); queue.close(); acquisitions.close(); }
  }));

test('missing Shoko metadata retries briefly, then backs off after a sustained miss',
  async () => fixture(async (dbPath) => {
    const queue = openAcquisitionRequestQueue(dbPath);
    try {
      let claim = queue.claimNext({ nowMs: 100 });
      queue.recordResult({ requestId: claim.requestId, pass: claim.pass,
        state: 'held', reason: 'shoko_metadata_missing', checkedMs: 100 });
      assert.equal(queue.getResult(1).nextDueMs, 60_100);
      assert.deepEqual(queue.listMetadataRetries(),
        [{ requestId: 1, nextDueMs: 60_100 }]);
      claim = queue.claimNext({ nowMs: 60_100, priorityRequestId: 1 });
      assert.equal(claim.requestId, 1);
      queue.recordResult({ requestId: 1, pass: claim.pass,
        state: 'held', reason: 'shoko_metadata_missing', checkedMs: 60_100 });
      assert.equal(queue.getResult(1).nextDueMs, 120_100);
      claim = queue.claimNext({ nowMs: 600_100, priorityRequestId: 1 });
      assert.equal(claim.requestId, 1);
      queue.recordResult({ requestId: 1, pass: claim.pass,
        state: 'held', reason: 'shoko_metadata_missing', checkedMs: 600_100 });
      assert.equal(queue.getResult(1).nextDueMs, 2_400_100);
    } finally { queue.close(); }
  }));

test('exact title metadata readiness wakes its held original request',
  async () => fixture(async (dbPath) => {
    const queue = openAcquisitionRequestQueue(dbPath);
    try {
      const claim = queue.claimNext({ nowMs: 100 });
      queue.recordResult({ requestId: claim.requestId, pass: claim.pass,
        state: 'held', reason: 'shoko_metadata_missing', checkedMs: 100 });
      assert.deepEqual(queue.wakeHydratedTitle({ anidbId: 43, nowMs: 1_000 }), []);
      assert.deepEqual(queue.wakeHydratedTitle({ anidbId: 41, nowMs: 1_000 }), [1]);
      assert.equal(queue.getResult(1).nextDueMs, 1_000);
      assert.equal(queue.claimNext({ nowMs: 1_000, priorityRequestId: 1 }).requestId, 1);
    } finally { queue.close(); }
  }));

test('startup brings legacy 30-minute metadata holds forward once',
  async () => fixture(async (dbPath) => {
    const queue = openAcquisitionRequestQueue(dbPath);
    try {
      const claim = queue.claimNext({ nowMs: 100 });
      queue.recordResult({ requestId: claim.requestId, pass: claim.pass,
        state: 'held', reason: 'shoko_metadata_missing', checkedMs: 100 });
      const db = new DatabaseSync(dbPath);
      try { db.prepare(`UPDATE acquisition_request_checks
        SET metadata_since_ms=NULL,next_due_ms=1800100 WHERE request_id=1`).run(); }
      finally { db.close(); }
      assert.deepEqual(queue.listMetadataRetries({ nowMs: 1_000 }),
        [{ requestId: 1, nextDueMs: 61_000 }]);
      assert.equal(queue.getResult(1).nextDueMs, 61_000);
    } finally { queue.close(); }
  }));

test('a transient external torrent collision retries in one minute, including saved holds',
  async () => fixture(async (dbPath) => {
    let queue = openAcquisitionRequestQueue(dbPath);
    try {
      const claim = queue.claimNext({ nowMs: 100 });
      queue.recordResult({ requestId: claim.requestId, pass: claim.pass,
        state: 'held', reason: 'torrent_hash_in_use', checkedMs: 100 });
      assert.equal(queue.getResult(1).nextDueMs, 60_100);
    } finally { queue.close(); }
    const old = new DatabaseSync(dbPath);
    old.prepare(`UPDATE acquisition_request_checks SET next_due_ms=1800100
      WHERE request_id=1`).run();
    old.close();
    queue = openAcquisitionRequestQueue(dbPath);
    try {
      assert.equal(queue.getResult(1).nextDueMs, 60_100);
      assert.deepEqual(queue.listMetadataRetries({ nowMs: 1_000 }),
        [{ requestId: 1, nextDueMs: 60_100 }]);
      assert.equal(queue.claimNext({ nowMs: 60_100,
        priorityRequestId: 1 }).requestId, 1);
    }
    finally { queue.close(); }
  }));

test('a request interrupted by service shutdown resumes promptly after restart',
  async () => fixture(async (dbPath) => {
    let queue = openAcquisitionRequestQueue(dbPath);
    try {
      const claim = queue.claimNext({ nowMs: 100 });
      queue.recordResult({ requestId: claim.requestId, pass: claim.pass,
        state: 'held', reason: 'service_stopping', checkedMs: 100 });
      assert.equal(queue.getResult(1).nextDueMs, 60_100);
    } finally { queue.close(); }
    const old = new DatabaseSync(dbPath);
    old.prepare(`UPDATE acquisition_request_checks SET next_due_ms=1800100
      WHERE request_id=1`).run();
    old.close();
    queue = openAcquisitionRequestQueue(dbPath);
    try {
      assert.equal(queue.getResult(1).nextDueMs, 60_100);
      assert.deepEqual(queue.listMetadataRetries({ nowMs: 1_000 }),
        [{ requestId: 1, nextDueMs: 60_100 }]);
      assert.equal(queue.claimNext({ nowMs: 60_100,
        priorityRequestId: 1 }).requestId, 1);
    } finally { queue.close(); }
  }));

test('an unavailable related-title lookup retries within five minutes',
  async () => fixture(async (dbPath) => {
    let queue = openAcquisitionRequestQueue(dbPath);
    try {
      const claim = queue.claimNext({ nowMs: 100 });
      queue.recordResult({ requestId: 1, pass: claim.pass,
        state: 'held', reason: 'related_title_unavailable', checkedMs: 100 });
      assert.equal(queue.getResult(1).nextDueMs, 300_100);
    } finally { queue.close(); }
    const legacy = new DatabaseSync(dbPath);
    legacy.prepare(`UPDATE acquisition_request_checks SET next_due_ms=1800100
      WHERE request_id=1`).run();
    legacy.close();
    queue = openAcquisitionRequestQueue(dbPath);
    try {
      assert.equal(queue.getResult(1).nextDueMs, 300_100);
    } finally { queue.close(); }
  }));

test('an incomplete provider search retries within one minute', async () =>
  fixture(async (dbPath) => {
    const queue = openAcquisitionRequestQueue(dbPath);
    try {
      const claim = queue.claimNext({ nowMs: 100 });
      queue.recordResult({ requestId: 1, pass: claim.pass,
        state: 'held', reason: 'release_search_incomplete', checkedMs: 100 });
      assert.equal(queue.getResult(1).nextDueMs, 60_100);
    } finally { queue.close(); }
  }));

test('an unverified Import quiet window retries after one minute without clearing its hold',
  async () => fixture(async (dbPath) => {
    let queue = openAcquisitionRequestQueue(dbPath);
    try {
      const claim = queue.claimNext({ nowMs: 100 });
      assert.equal(claim.requestId, 1);
      queue.recordResult({ requestId: 1, pass: claim.pass,
        state: 'held', reason: 'import_quiet_window_unverified', checkedMs: 100 });
      assert.equal(queue.getResult(1).reason, 'import_quiet_window_unverified');
      assert.equal(queue.getResult(1).nextDueMs, 60_100);
    } finally { queue.close(); }
    const legacy = new DatabaseSync(dbPath);
    try { legacy.prepare(`UPDATE acquisition_request_checks
      SET next_due_ms=1800100 WHERE request_id=1`).run(); }
    finally { legacy.close(); }
    queue = openAcquisitionRequestQueue(dbPath);
    try { assert.equal(queue.getResult(1).nextDueMs, 60_100); }
    finally { queue.close(); }
  }));

test('a newly saved request can be checked first without advancing the ordinary cursor',
  async () => fixture(async (dbPath) => {
    const queue = openAcquisitionRequestQueue(dbPath);
    try {
      assert.deepEqual(queue.claimNext({ nowMs: 10, priorityRequestId: 3 }),
        { state: 'claimed', requestId: 3, pass: 1 });
      assert.deepEqual(queue.claimNext({ nowMs: 10, priorityRequestId: 3 }),
        { state: 'claimed', requestId: 1, pass: 1 });
    } finally { queue.close(); }
  }));

test('priority cannot bypass a suspension or title cohort',
  async () => fixture(async (dbPath) => {
    const queue = openAcquisitionRequestQueue(dbPath,
      { allowedAnidbIds: [42] });
    try {
      assert.deepEqual(queue.suspendUnstarted({ requestId: 2,
        reason: 'cutover_review', nowMs: 10 }), { state: 'suspended' });
      assert.equal(queue.claimNext({ nowMs: 10, priorityRequestId: 2 }).state,
        'pass_complete');
      assert.equal(queue.claimNext({ nowMs: 10, priorityRequestId: 3 }).state,
        'pass_complete');
    } finally { queue.close(); }
  }));

test('an Airing release miss backs off hourly, then six-hourly and daily', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-rss-fallback-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const requests = openRequestLedger(dbPath);
  requests.submit({ requesterId: 1, requestKey: 'airing',
    intent: { ...intent, monitorFuture: true }, nowMs: 1 });
  const queue = openAcquisitionRequestQueue(dbPath);
  try {
    let claim = queue.claimNext({ nowMs: 100 });
    queue.recordResult({ requestId: 1, pass: claim.pass, state: 'held',
      reason: 'no_release_candidates', checkedMs: 100 });
    assert.equal(queue.getResult(1).nextDueMs, 100 + 3_600_000);
    assert.equal(queue.claimNext({ nowMs: 101 }).state, 'pass_complete');
    claim = queue.claimNext({ nowMs: 86_400_101 });
    queue.recordResult({ requestId: 1, pass: claim.pass, state: 'held',
      reason: 'no_release_candidates', checkedMs: 86_400_101 });
    assert.equal(queue.getResult(1).nextDueMs, 86_400_101 + 6 * 3_600_000);
  } finally { queue.close(); requests.close();
    await rm(dir, { recursive: true, force: true }); }
});

test('temporary qBittorrent authentication backoff retries on the next request cycle',
  async () => fixture(async (dbPath) => {
    const queue = openAcquisitionRequestQueue(dbPath);
    try {
      const claim = queue.claimNext({ nowMs: 1_000 });
      queue.recordResult({ requestId: claim.requestId, pass: claim.pass,
        state: 'held', reason: 'authentication_backoff', checkedMs: 1_001 });
      assert.equal(queue.getResult(claim.requestId).nextDueMs, 61_001);
    } finally { queue.close(); }
  }));

test('a live ownership gate skips Sonarr titles without claiming them',
  async () => fixture(async (dbPath) => {
    let owned = new Set([41, 42]);
    const gate = { status: (id) => owned.has(id) ? 'owned' : 'eligible' };
    const queue = openAcquisitionRequestQueue(dbPath,
      { ownershipGate: gate });
    try {
      assert.deepEqual(queue.claimNext({ nowMs: 10 }),
        { state: 'claimed', requestId: 3, pass: 1 });
      assert.equal(queue.claimNext({ nowMs: 10 }).state, 'pass_complete');
      owned = new Set();
      assert.equal(queue.claimNext({ nowMs: 11 }).requestId, 1);
      assert.equal(queue.claimNext({ nowMs: 11 }).requestId, 2);
    } finally { queue.close(); }
  }));

test('an unavailable ownership gate cannot claim a request',
  async () => fixture(async (dbPath) => {
    const queue = openAcquisitionRequestQueue(dbPath,
      { ownershipGate: { status: () => 'unavailable' } });
    try {
      assert.deepEqual(queue.claimNext({ nowMs: 10 }),
        { state: 'held', reason: 'sonarr_ownership_unavailable' });
      const db = new DatabaseSync(dbPath);
      try { assert.equal(db.prepare('SELECT count(*) AS total FROM acquisition_request_checks').get().total, 0); }
      finally { db.close(); }
    } finally { queue.close(); }
  }));

test('an exact acquisition cohort skips other saved titles across restart',
  async () => fixture(async (dbPath) => {
    const first = openAcquisitionRequestQueue(dbPath, { allowedAnidbIds: [42] });
    try {
      assert.deepEqual(first.claimNext({ nowMs: 10 }),
        { state: 'claimed', requestId: 2, pass: 1 });
      assert.deepEqual(first.claimNext({ nowMs: 10 }),
        { state: 'pass_complete', pass: 1 });
    } finally { first.close(); }
    const reopened = openAcquisitionRequestQueue(dbPath,
      { allowedAnidbIds: [42] });
    try {
      assert.deepEqual(reopened.claimNext({ nowMs: 10 }),
        { state: 'pass_complete', pass: 2 });
    } finally { reopened.close(); }
    const unrestricted = openAcquisitionRequestQueue(dbPath);
    try {
      assert.equal(unrestricted.claimNext({ nowMs: 10 }).requestId, 1);
    } finally { unrestricted.close(); }
  }));

test('a suspended unstarted request is skipped while existing and new requests continue',
  async () => fixture(async (dbPath) => {
    const queue = openAcquisitionRequestQueue(dbPath);
    try {
      assert.deepEqual(queue.suspendUnstarted({ requestId: 2,
        reason: 'cutover_review', nowMs: 10 }), { state: 'suspended' });
      assert.equal(queue.claimNext({ nowMs: 11 }).requestId, 1);
      assert.equal(queue.claimNext({ nowMs: 11 }).requestId, 3);
      assert.equal(queue.claimNext({ nowMs: 11 }).state, 'pass_complete');
    } finally { queue.close(); }
    const requests = openRequestLedger(dbPath);
    try { requests.submit({ requesterId: 1, requestKey: 'new',
      intent: { ...intent, anidbId: 44 }, nowMs: 12 }); }
    finally { requests.close(); }
    const reopened = openAcquisitionRequestQueue(dbPath);
    try {
      assert.equal(reopened.claimNext({ nowMs: 12 }).requestId, 4);
      assert.equal(reopened.claimNext({ nowMs: 12 }).state, 'pass_complete');
      assert.deepEqual(reopened.resumeSuspended({ requestId: 2 }),
        { state: 'resumed' });
      assert.equal(reopened.claimNext({ nowMs: 13 }).requestId, 2);
    } finally { reopened.close(); }
  }));

test('suspension cannot hide a request already claimed by a worker',
  async () => fixture(async (dbPath) => {
    const worker = openAcquisitionRequestQueue(dbPath);
    const admin = openAcquisitionRequestQueue(dbPath);
    try {
      assert.equal(worker.claimNext({ nowMs: 10 }).requestId, 1);
      assert.deepEqual(admin.suspendUnstarted({ requestId: 1,
        reason: 'cutover_review', nowMs: 11 }),
      { state: 'held', reason: 'request_started_or_unavailable' });
      assert.equal(admin.getSuspension(1), null);
      assert.deepEqual(admin.suspendUnstarted({ requestId: 2,
        reason: 'cutover_review', nowMs: 11 }), { state: 'suspended' });
      assert.deepEqual(admin.getSuspension(2), { requestId: 2,
        reason: 'cutover_review', recordedMs: 11 });
      assert.deepEqual(admin.suspendUnstarted({ requestId: 2,
        reason: 'cutover_review', nowMs: 12 }), { state: 'suspended' });
      assert.equal(worker.claimNext({ nowMs: 12 }).requestId, 3);
      assert.deepEqual(admin.resumeSuspended({ requestId: 2 }),
        { state: 'resumed' });
      assert.deepEqual(admin.resumeSuspended({ requestId: 2 }),
        { state: 'held', reason: 'not_suspended' });
      assert.equal(worker.claimNext({ nowMs: 12 }).state, 'pass_complete');
      assert.equal(worker.claimNext({ nowMs: 12 }).requestId, 2);
    } finally { worker.close(); admin.close(); }
  }));

test('a saved download attempt cannot be disguised as an unstarted suspension',
  async () => fixture(async (dbPath) => {
    const acquisitions = openAcquisitionLedger(dbPath);
    const queue = openAcquisitionRequestQueue(dbPath);
    try {
      acquisitions.reserve({ requestId: 2,
        candidate: { indexerId: 7, guid: 'already-selected' },
        episodeIds: [1001], nowMs: 10 });
      assert.deepEqual(queue.suspendUnstarted({ requestId: 2,
        reason: 'cutover_review', nowMs: 11 }),
      { state: 'held', reason: 'request_started_or_unavailable' });
      assert.equal(queue.getSuspension(2), null);
    } finally { queue.close(); acquisitions.close(); }
  }));

test('cutover hold preserves a started request and resumes it after reopen',
  async () => fixture(async (dbPath) => {
    const acquisitions = openAcquisitionLedger(dbPath);
    let queue = openAcquisitionRequestQueue(dbPath);
    try {
      acquisitions.reserve({ requestId: 2,
        candidate: { indexerId: 7, guid: 'saved-attempt' },
        episodeIds: [1001], nowMs: 10 });
      assert.deepEqual(queue.suspendForCutover({ requestId: 2,
        reason: 'cutover_review', nowMs: 11 }), { state: 'suspended' });
      assert.equal(queue.claimNext({ nowMs: 12 }).requestId, 1);
      assert.equal(queue.claimNext({ nowMs: 12 }).requestId, 3);
      assert.equal(queue.claimNext({ nowMs: 12 }).state, 'pass_complete');
      queue.close();
      queue = openAcquisitionRequestQueue(dbPath);
      assert.deepEqual(queue.getSuspension(2), { requestId: 2,
        reason: 'cutover_review', recordedMs: 11 });
      assert.deepEqual(queue.resumeSuspended({ requestId: 2 }),
        { state: 'resumed' });
      assert.equal(queue.claimNext({ nowMs: 13 }).requestId, 2);
      const db = new DatabaseSync(dbPath);
      try {
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM acquisition_attempts WHERE request_id=2').get().count, 1);
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM requests').get().count, 3);
      } finally { db.close(); }
    } finally { queue.close(); acquisitions.close(); }
  }));

test('cutover hold refuses a started request with an unfinished worker claim',
  async () => fixture(async (dbPath) => {
    const acquisitions = openAcquisitionLedger(dbPath);
    const queue = openAcquisitionRequestQueue(dbPath);
    try {
      acquisitions.reserve({ requestId: 2,
        candidate: { indexerId: 7, guid: 'prior-attempt' },
        episodeIds: [1001], nowMs: 10 });
      assert.equal(queue.claimNext({ nowMs: 11 }).requestId, 1);
      const active = queue.claimNext({ nowMs: 11 });
      assert.equal(active.requestId, 2);
      assert.deepEqual(queue.suspendForCutover({ requestId: 2,
        reason: 'cutover_review', nowMs: 12 }),
      { state: 'held', reason: 'request_inflight' });
      assert.equal(queue.getSuspension(2), null);
      assert.deepEqual(queue.recordResult({ requestId: 2, pass: active.pass,
        state: 'held', reason: 'no_safe_release', checkedMs: 13 }),
      { state: 'recorded' });
      assert.deepEqual(queue.suspendForCutover({ requestId: 2,
        reason: 'cutover_review', nowMs: 14 }), { state: 'suspended' });
    } finally { queue.close(); acquisitions.close(); }
  }));

test('batch suspension is all-or-nothing and keeps the remaining queue live',
  async () => fixture(async (dbPath) => {
    const queue = openAcquisitionRequestQueue(dbPath);
    try {
      const first = queue.claimNext({ nowMs: 10 });
      assert.equal(first.requestId, 1);
      assert.deepEqual(queue.suspendUnstartedBatch({ requestIds: [2, 1, 3],
        reason: 'cutover_review', nowMs: 11 }),
      { state: 'held', reason: 'request_started_or_unavailable' });
      assert.equal(queue.getSuspension(2), null);
      assert.equal(queue.getSuspension(3), null);
      assert.deepEqual(queue.suspendUnstartedBatch({ requestIds: [2, 3],
        reason: 'cutover_review', nowMs: 12 }),
      { state: 'suspended', count: 2 });
      assert.equal(queue.claimNext({ nowMs: 13 }).state, 'pass_complete');
      assert.deepEqual(queue.suspendUnstartedBatch({ requestIds: [2, 3],
        reason: 'cutover_review', nowMs: 14 }),
      { state: 'suspended', count: 2 });
      assert.equal(queue.getSuspension(2).recordedMs, 12);
    } finally { queue.close(); }
  }));

test('completed checks without a download remain eligible for atomic cutover hold',
  async () => fixture(async (dbPath) => {
    const queue = openAcquisitionRequestQueue(dbPath);
    try {
      const checked = queue.claimNext({ nowMs: 10 });
      assert.equal(checked.requestId, 1);
      assert.deepEqual(queue.recordResult({ requestId: 1, pass: checked.pass,
        state: 'held', reason: 'no_release_candidates', checkedMs: 10 }),
      { state: 'recorded' });
      assert.deepEqual(queue.suspendUnstartedBatch({ requestIds: [1, 2],
        reason: 'cutover_review', nowMs: 11 }),
      { state: 'suspended', count: 2 });
      assert.equal(queue.getSuspension(1)?.requestId, 1);
      assert.equal(queue.getSuspension(2)?.requestId, 2);
      assert.equal(queue.claimNext({ nowMs: 11 }).requestId, 3);
    } finally { queue.close(); }
  }));

test('cancelled requests are not claimed while later requests continue', async () =>
  fixture(async (dbPath) => {
    const requests = openRequestLedger(dbPath);
    const queue = openAcquisitionRequestQueue(dbPath);
    try {
      assert.equal(requests.cancelRequest({ requesterId: 1, requestId: 1,
        nowMs: 10 }).state, 'cancelled');
      assert.equal(queue.claimNext({ nowMs: 11 }).requestId, 2);
      assert.equal(queue.claimNext({ nowMs: 11 }).requestId, 3);
      assert.equal(queue.claimNext({ nowMs: 11 }).state, 'pass_complete');
    } finally { queue.close(); requests.close(); }
  }));

test('a forward candidate cursor can continue next pass without a 30-minute delay', async () =>
  fixture(async (dbPath) => {
    const queue = openAcquisitionRequestQueue(dbPath);
    const fingerprint = `${'a'.repeat(64)}:${'b'.repeat(64)},${'c'.repeat(64)}`;
    try {
      const first = queue.claimNext({ nowMs: 100 });
      assert.equal(first.requestId, 1);
      assert.deepEqual(queue.recordResult({ requestId: 1, pass: first.pass,
        state: 'held', reason: 'target_busy', nextCandidateOffset: 1,
        nextCandidateFingerprint: fingerprint, checkedMs: 100 }),
      { state: 'recorded' });
      assert.equal(queue.getResult(1).nextDueMs, 100);
      assert.equal(queue.claimNext({ nowMs: 100 }).requestId, 2);
      assert.equal(queue.claimNext({ nowMs: 100 }).requestId, 3);
      assert.equal(queue.claimNext({ nowMs: 100 }).state, 'pass_complete');
      const second = queue.claimNext({ nowMs: 100 });
      assert.equal(second.requestId, 1);
      assert.equal(second.candidateOffset, 1);
      queue.recordResult({ requestId: 1, pass: second.pass, state: 'held',
        reason: 'provider_unavailable', nextCandidateOffset: 1,
        nextCandidateFingerprint: fingerprint, checkedMs: 101 });
      assert.equal(queue.getResult(1).nextDueMs, 60_101);
    } finally { queue.close(); }
  }));

test('a candidate scan keeps its original start across pages and exhausted retries', async () =>
  fixture(async (dbPath) => {
    const queue = openAcquisitionRequestQueue(dbPath);
    const fingerprint = `${'a'.repeat(64)}:${'b'.repeat(64)},${'c'.repeat(64)}`;
    try {
      const first = queue.claimNext({ nowMs: 100 });
      assert.equal(queue.getScanStartedMs(first.requestId), 100);
      queue.recordResult({ requestId: 1, pass: first.pass,
        state: 'held', reason: 'no_safe_release', nextCandidateOffset: 1,
        nextCandidateFingerprint: fingerprint, checkedMs: 200 });
      queue.claimNext({ nowMs: 201 });
      queue.claimNext({ nowMs: 201 });
      queue.claimNext({ nowMs: 201 });
      const second = queue.claimNext({ nowMs: 300 });
      assert.equal(second.requestId, 1);
      assert.equal(queue.getScanStartedMs(1), 100);
      queue.recordResult({ requestId: 1, pass: second.pass,
        state: 'held', reason: 'no_safe_release', nextCandidateOffset: 0,
        checkedMs: 301 });
      queue.claimNext({ nowMs: 302 });
      queue.claimNext({ nowMs: 302 });
      queue.claimNext({ nowMs: 302 });
      const third = queue.claimNext({ nowMs: 1_800_302 });
      assert.equal(third.requestId, 1);
      assert.equal(queue.getScanStartedMs(1), 100);
    } finally { queue.close(); }
  }));

test('startup restores permanent busy-reader request deadlines without resetting elapsed time', async () =>
  fixture(async (dbPath) => {
    let queue = openAcquisitionRequestQueue(dbPath);
    const claim = queue.claimNext({ nowMs: 100 });
    queue.recordResult({ requestId: claim.requestId, pass: claim.pass,
      state: 'held', reason: 'metadata_reader_busy', checkedMs: 200 });
    queue.close();
    const db = new DatabaseSync(dbPath);
    db.exec('UPDATE acquisition_request_checks SET next_due_ms=NULL WHERE request_id=1');
    db.close();
    queue = openAcquisitionRequestQueue(dbPath);
    try {
      assert.equal(queue.getResult(1).nextDueMs, 60_200);
      assert.equal(queue.getScanStartedMs(1), 100);
      assert.equal(queue.listMetadataRetries({ nowMs: 300 })[0].requestId, 1);
    } finally { queue.close(); }
  }));

test('a newly aired target becomes immediately due and starts its own decision clock', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-new-target-clock-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const requests = openRequestLedger(dbPath);
  requests.submit({ requesterId: 1, requestKey: 'watch', nowMs: 1,
    intent: { ...intent, monitorFuture: true } });
  const queue = openAcquisitionRequestQueue(dbPath);
  try {
    const claim = queue.claimNext({ nowMs: 100 });
    queue.recordResult({ requestId: 1, pass: claim.pass, state: 'held',
      reason: 'no_release_candidates', nextCandidateOffset: 0, checkedMs: 200 });
    assert.equal(queue.getDecisionTiming(1).elapsedMs, 100);
    const advanced = requests.advanceAiring({ requestId: 1, releaseState: 'airing', today: '2026-11-20',
      detail: { state: 'details', complete: true, anidbId: 42, kind: 'series',
        title: 'Example', total: 2, page: 1, nextPage: null, restricted: false,
        episodes: [1,2].map(number => ({ id: 1000 + number, number, type: 'Episode',
          title: String(number), airDate: '2026-11-19' })) } });
    assert.deepEqual(advanced.addedEpisodeIds, [1002], JSON.stringify(advanced));
    assert.equal(queue.listMetadataRetries({ nowMs: 300 })[0].nextDueMs, 0);
    const next = queue.claimNext({ nowMs: 300, priorityRequestId: 1 });
    assert.equal(next.state, 'claimed');
    assert.equal(queue.getScanStartedMs(1), 300);
    assert.equal(queue.getDecisionTiming(1).decisionMs, null);
  } finally { queue.close(); requests.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a legacy timed-out candidate scan resumes promptly after reopening', async () =>
  fixture(async (dbPath) => {
    let queue = openAcquisitionRequestQueue(dbPath);
    const fingerprint = `${'a'.repeat(64)}:${'b'.repeat(64)},${'c'.repeat(64)}`;
    try {
      const first = queue.claimNext({ nowMs: 100 });
      queue.recordResult({ requestId: 1, pass: first.pass,
        state: 'held', reason: 'candidate_scan_time_budget',
        nextCandidateOffset: 1, nextCandidateFingerprint: fingerprint,
        checkedMs: 900_101 });
      assert.equal(queue.getResult(1).nextDueMs, 960_101);
      assert.equal(queue.getScanStartedMs(1), 100);
    } finally { queue.close(); }
    const legacy = new DatabaseSync(dbPath);
    legacy.prepare(`UPDATE acquisition_request_checks SET next_due_ms=?
      WHERE request_id=1`).run(1_800_101);
    legacy.close();
    queue = openAcquisitionRequestQueue(dbPath);
    try {
      assert.equal(queue.getResult(1).nextDueMs, 960_101);
      queue.claimNext({ nowMs: 960_101 });
      queue.claimNext({ nowMs: 960_101 });
      queue.claimNext({ nowMs: 960_101 });
      const next = queue.claimNext({ nowMs: 960_101 });
      assert.equal(next.requestId, 1);
      assert.equal(next.candidateOffset, 1);
      assert.equal(queue.getScanStartedMs(1), 100);
    } finally { queue.close(); }
  }));

test('a changed candidate policy fingerprint does not erase acquisition elapsed time', async () =>
  fixture(async (dbPath) => {
    const queue = openAcquisitionRequestQueue(dbPath);
    const oldCursor = `${'a'.repeat(64)}:${'b'.repeat(64)},${'c'.repeat(64)}`;
    const newCursor = `${'d'.repeat(64)}:${'b'.repeat(64)},${'c'.repeat(64)}`;
    try {
      const first = queue.claimNext({ nowMs: 100 });
      queue.recordResult({ requestId: 1, pass: first.pass,
        state: 'held', reason: 'no_safe_release', nextCandidateOffset: 1,
        nextCandidateFingerprint: oldCursor, checkedMs: 200 });
      queue.claimNext({ nowMs: 201 });
      queue.claimNext({ nowMs: 201 });
      queue.claimNext({ nowMs: 201 });
      const second = queue.claimNext({ nowMs: 201 });
      assert.equal(second.state, 'claimed');
      queue.recordResult({ requestId: 1, pass: second.pass,
        state: 'held', reason: 'no_safe_release', nextCandidateOffset: 1,
        nextCandidateFingerprint: newCursor, checkedMs: 900_001 });
      assert.equal(queue.getScanStartedMs(1), 100);
    } finally { queue.close(); }
  }));

test('a later pack phase with a lower offset stays promptly eligible', async () =>
  fixture(async (dbPath) => {
    const queue = openAcquisitionRequestQueue(dbPath);
    const packCursor = `${'a'.repeat(64)}:${'b'.repeat(64)},${'c'.repeat(64)}`;
    const nextCursor = `${'d'.repeat(64)}:${'b'.repeat(64)},${'c'.repeat(64)}`;
    try {
      const first = queue.claimNext({ nowMs: 100 });
      queue.recordResult({ requestId: 1, pass: first.pass,
        state: 'held', reason: 'season_pack_scan_complete',
        nextCandidateOffset: 2, nextCandidateFingerprint: packCursor,
        checkedMs: 200 });
      queue.claimNext({ nowMs: 201 });
      queue.claimNext({ nowMs: 201 });
      queue.claimNext({ nowMs: 201 });
      const second = queue.claimNext({ nowMs: 201 });
      assert.equal(second.state, 'claimed');
      queue.recordResult({ requestId: 1, pass: second.pass,
        state: 'held', reason: 'season_pack_search_pending',
        nextCandidateOffset: 1, nextCandidateFingerprint: nextCursor,
        checkedMs: 300 });
      assert.equal(queue.getResult(1).nextDueMs, 300);
    } finally { queue.close(); }
  }));

test('a due pack continuation is priority eligible and keeps its saved cursor', async () =>
  fixture(async (dbPath) => {
    const queue = openAcquisitionRequestQueue(dbPath);
    const fingerprint = `${'a'.repeat(64)}:${'b'.repeat(64)},${'c'.repeat(64)}`;
    try {
      const first = queue.claimNext({ nowMs: 100 });
      queue.recordResult({ requestId: 1, pass: first.pass,
        state: 'held', reason: 'season_pack_search_pending',
        nextCandidateOffset: 1, nextCandidateFingerprint: fingerprint,
        checkedMs: 200 });
      assert.equal(queue.getResult(1).nextDueMs, 200);
      assert.deepEqual(queue.claimNext({ nowMs: 200, priorityRequestId: 1 }),
        { state: 'claimed', requestId: 1, pass: first.pass,
          candidateOffset: 1, candidateFingerprint: fingerprint });
    } finally { queue.close(); }
  }));

test('a due no-safe-release page with more candidates is priority eligible', async () =>
  fixture(async (dbPath) => {
    const queue = openAcquisitionRequestQueue(dbPath);
    const fingerprint = `${'a'.repeat(64)}:${'b'.repeat(64)},${'c'.repeat(64)}`;
    try {
      const first = queue.claimNext({ nowMs: 100 });
      queue.recordResult({ requestId: 1, pass: first.pass,
        state: 'held', reason: 'no_safe_release',
        nextCandidateOffset: 1, nextCandidateFingerprint: fingerprint,
        checkedMs: 200 });
      assert.equal(queue.getResult(1).nextDueMs, 200);
      assert.deepEqual(queue.claimNext({ nowMs: 200, priorityRequestId: 1 }),
        { state: 'claimed', requestId: 1, pass: first.pass,
          candidateOffset: 1, candidateFingerprint: fingerprint });
    } finally { queue.close(); }
  }));

test('the first page after a pack-phase transition remains due', async () =>
  fixture(async (dbPath) => {
    const queue = openAcquisitionRequestQueue(dbPath);
    const pack = `${'a'.repeat(64)}:${'b'.repeat(64)},${'c'.repeat(64)},${'d'.repeat(64)},${'e'.repeat(64)}`;
    const next = `${'f'.repeat(64)}:${'b'.repeat(64)},${'c'.repeat(64)},${'d'.repeat(64)},${'e'.repeat(64)}`;
    try {
      let claim = queue.claimNext({ nowMs: 100 });
      queue.recordResult({ requestId: 1, pass: claim.pass,
        state: 'held', reason: 'season_pack_search_pending',
        nextCandidateOffset: 3, nextCandidateFingerprint: pack,
        checkedMs: 150 });
      claim = queue.claimNext({ nowMs: 151, priorityRequestId: 1 });
      queue.recordResult({ requestId: 1, pass: claim.pass,
        state: 'held', reason: 'season_pack_scan_complete',
        nextCandidateOffset: 4, nextCandidateFingerprint: next,
        checkedMs: 200 });
      claim = queue.claimNext({ nowMs: 201, priorityRequestId: 1 });
      assert.equal(claim.requestId, 1);
      assert.equal(claim.candidateOffset, 4);
      queue.recordResult({ requestId: 1, pass: claim.pass,
        state: 'held', reason: 'season_pack_search_pending',
        nextCandidateOffset: 3, nextCandidateFingerprint: next,
        checkedMs: 300 });
      assert.equal(queue.getResult(1).nextDueMs, 300);
    } finally { queue.close(); }
  }));

test('a completed pack scan can enter the next bounded phase immediately', async () =>
  fixture(async (dbPath) => {
    const queue = openAcquisitionRequestQueue(dbPath);
    const firstCursor = `${'a'.repeat(64)}:${'b'.repeat(64)},${'c'.repeat(64)}`;
    const secondCursor = `${'d'.repeat(64)}:${'b'.repeat(64)},${'c'.repeat(64)}`;
    try {
      const first = queue.claimNext({ nowMs: 100 });
      queue.recordResult({ requestId: 1, pass: first.pass,
        state: 'held', reason: 'season_pack_scan_complete',
        nextCandidateOffset: 2, nextCandidateFingerprint: firstCursor,
        checkedMs: 100 });
      assert.equal(queue.getResult(1).nextDueMs, 100);
      queue.claimNext({ nowMs: 100 });
      queue.claimNext({ nowMs: 100 });
      assert.equal(queue.claimNext({ nowMs: 100 }).state, 'pass_complete');
      const second = queue.claimNext({ nowMs: 101 });
      assert.equal(second.requestId, 1);
      queue.recordResult({ requestId: 1, pass: second.pass,
        state: 'held', reason: 'season_pack_uncertain_complete',
        nextCandidateOffset: 2, nextCandidateFingerprint: secondCursor,
        checkedMs: 101 });
      assert.equal(queue.getResult(1).nextDueMs, 101);
    } finally { queue.close(); }
  }));

test('future-only watch is skipped until its first episode target is added', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-future-queue-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const requests = openRequestLedger(dbPath);
  const saved = requests.submit({ requesterId: 1, requestKey: 'future',
    intent: { ...intent, episodeIds: [], monitorFuture: true }, nowMs: 1 });
  const queue = openAcquisitionRequestQueue(dbPath);
  try {
    assert.equal(queue.claimNext({ nowMs: 1 }).state, 'pass_complete');
    requests.advanceAiring({ requestId: saved.requestId,
      detail: { state: 'details', anidbId: 42, kind: 'series',
        complete: true, total: 1, episodes: [
          { id: 1001, type: 'Episode', airDate: '2026-11-01' },
        ] }, releaseState: 'airing', today: '2026-11-01' });
    assert.equal(queue.claimNext({ nowMs: 2 }).requestId, saved.requestId);
  } finally { queue.close(); requests.close();
    await rm(dir, { recursive: true, force: true }); }
});

async function fixture(run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-acquisition-queue-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const requests = openRequestLedger(dbPath);
  for (let i = 1; i <= 3; i++) requests.submit({ requesterId: 1,
    requestKey: `request-${i}`, intent: { ...intent, anidbId: 40 + i }, nowMs: i });
  requests.close();
  try { await run(dbPath); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

test('claims each request once per pass across two connections and survives restart', async () =>
  fixture(async (dbPath) => {
    const one = openAcquisitionRequestQueue(dbPath);
    const two = openAcquisitionRequestQueue(dbPath);
    try {
      assert.deepEqual(one.claimNext(), { state: 'claimed', requestId: 1, pass: 1 });
      assert.deepEqual(two.claimNext(), { state: 'claimed', requestId: 2, pass: 1 });
      assert.deepEqual(one.claimNext(), { state: 'claimed', requestId: 3, pass: 1 });
      assert.deepEqual(two.claimNext(), { state: 'pass_complete', pass: 1 });
      for (let requestId = 1; requestId <= 3; requestId++) {
        one.recordResult({ requestId, pass: 1, state: 'held',
          reason: 'not_ready', checkedMs: 10 });
      }
      assert.deepEqual(two.claimNext(), { state: 'claimed', requestId: 1, pass: 2 });
    } finally { one.close(); two.close(); }
    const reopened = openAcquisitionRequestQueue(dbPath);
    try { assert.deepEqual(reopened.claimNext(),
      { state: 'claimed', requestId: 2, pass: 2 }); }
    finally { reopened.close(); }
  }));

test('unresolved claim cannot be reprocessed on a later pass but new requests can advance', async () =>
  fixture(async (dbPath) => {
    const first = openAcquisitionRequestQueue(dbPath);
    assert.equal(first.claimNext().requestId, 1);
    first.close();
    const second = openAcquisitionRequestQueue(dbPath);
    try {
      assert.deepEqual(second.listUnresolved(), [{ requestId: 1, pass: 1 }]);
      assert.equal(second.claimNext().requestId, 2);
      assert.equal(second.claimNext().requestId, 3);
      assert.deepEqual(second.listUnresolved(), [
        { requestId: 1, pass: 1 }, { requestId: 2, pass: 1 },
        { requestId: 3, pass: 1 },
      ]);
      assert.deepEqual(second.claimNext(), { state: 'pass_complete', pass: 1 });
      assert.deepEqual(second.claimNext(), { state: 'pass_complete', pass: 2 });
      const requests = openRequestLedger(dbPath);
      try { requests.submit({ requesterId: 1, requestKey: 'later',
        intent: { ...intent, anidbId: 44 }, nowMs: 4 }); }
      finally { requests.close(); }
      assert.deepEqual(second.claimNext(), { state: 'claimed', requestId: 4, pass: 3 });
      assert.equal(second.getResult(1).state, null);
      assert.deepEqual(second.recordResult({ requestId: 1, pass: 1,
        state: 'held', reason: 'reconciled_no_dispatch', checkedMs: 20 }),
      { state: 'recorded' });
      assert.deepEqual(second.listUnresolved().map((item) => item.requestId), [2, 3, 4]);
      assert.deepEqual(second.recordResult({ requestId: 1, pass: 1,
        state: 'held', reason: 'reconciled_no_dispatch', checkedMs: 21 }),
      { state: 'held', reason: 'stale_claim' });
    } finally { second.close(); }
  }));

test('held and failed requests are recorded while later requests continue', async () =>
  fixture(async (dbPath) => {
    const queue = openAcquisitionRequestQueue(dbPath);
    const seen = [];
    const passes = [];
    try {
      const worker = createAcquisitionPageWorker({ queue, limit: 3, now: () => 100,
        processRequest: async ({ requestId, pass }) => {
          seen.push(requestId);
          passes.push(pass);
          if (requestId === 1) return { state: 'held', reason: 'shoko_unrecognized' };
          if (requestId === 2) throw Error('private provider detail');
          return { state: 'stopped_observed', attemptId: 77 };
        } });
      const page = await worker.runOnce();
      assert.equal(page.state, 'page');
      assert.deepEqual(seen, [1, 2, 3]);
      assert.deepEqual(passes, [1, 1, 1]);
      assert.deepEqual(page.results.map((result) => result.state),
        ['held', 'held', 'stopped_observed']);
      assert.equal(page.results.find((result) => result.requestId === 3).nextDueMs,
        60_100);
      assert.deepEqual(queue.getResult(1), { requestId: 1, pass: 1, attemptId: null,
        state: 'held', reason: 'shoko_unrecognized', checkedMs: 100,
        nextDueMs: 1_800_100 });
      assert.deepEqual(queue.getResult(2), { requestId: 2, pass: 1, attemptId: null,
        state: 'held', reason: 'worker_unavailable', checkedMs: 100,
        nextDueMs: 1_800_100 });
      assert.deepEqual(queue.listMetadataRetries({ nowMs: 1_000 }),
        [{ requestId: 3, nextDueMs: 60_100 }, { requestId: 1, nextDueMs: 1_800_100 },
          { requestId: 2, nextDueMs: 1_800_100 }]);
      assert.deepEqual(await worker.runOnce(), { state: 'pass_complete', pass: 1, results: [] });
      assert.deepEqual(await worker.runOnce(), { state: 'pass_complete', pass: 2, results: [] });
      const continuation = queue.claimNext({ nowMs: 60_100, priorityRequestId: 3 });
      assert.equal(continuation.requestId, 3);
      assert.equal(queue.recordResult({ requestId: 3, pass: continuation.pass,
        state: 'stopped_observed', attemptId: 77, checkedMs: 60_100 }).state,
      'recorded');
      assert.deepEqual(queue.claimNext({ nowMs: 1_800_100 }),
        { state: 'claimed', requestId: 1, pass: 3 });
      assert.equal(queue.getResult(3).attemptId, 77);
    } finally { queue.close(); }
  }));

test('full public proof ends Completed acquisition but not Airing monitoring', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-one-time-queue-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const requests = openRequestLedger(dbPath);
  requests.submit({ requesterId: 1, requestKey: 'completed',
    intent, nowMs: 1 });
  requests.submit({ requesterId: 1, requestKey: 'airing',
    intent: { ...intent, anidbId: 43, monitorFuture: true }, nowMs: 2 });
  requests.submit({ requesterId: 1, requestKey: 'partially-available',
    intent: { ...intent, anidbId: 44 }, nowMs: 3 });
  let queue = openAcquisitionRequestQueue(dbPath);
  try {
    assert.equal(queue.claimNext({ nowMs: 100 }).requestId, 1);
    assert.equal(queue.claimNext({ nowMs: 100 }).requestId, 2);
    assert.equal(queue.claimNext({ nowMs: 100 }).requestId, 3);
    assert.equal(queue.claimNext({ nowMs: 100 }).state, 'pass_complete');
    for (const requestId of [1, 2]) {
      assert.deepEqual(queue.recordResult({ requestId, pass: 1,
        state: 'held', reason: 'request_fully_available', checkedMs: 100 }),
      { state: 'recorded' });
    }
    queue.recordResult({ requestId: 3, pass: 1, state: 'held',
      reason: 'target_already_available', checkedMs: 100 });
    queue.close();
    queue = openAcquisitionRequestQueue(dbPath);
    assert.equal(queue.claimNext({ nowMs: 1_800_101 }).requestId, 2);
    assert.equal(queue.claimNext({ nowMs: 1_800_101 }).requestId, 3);
    assert.equal(queue.claimNext({ nowMs: 1_800_101 }).state, 'pass_complete');
  } finally { queue.close(); requests.close();
    await rm(dir, { recursive: true, force: true }); }
});

test('a new request added during a pass is claimed before wrap', async () =>
  fixture(async (dbPath) => {
    const queue = openAcquisitionRequestQueue(dbPath);
    try {
      for (let id = 1; id <= 3; id++) assert.equal(queue.claimNext().requestId, id);
      const requests = openRequestLedger(dbPath);
      try { requests.submit({ requesterId: 1, requestKey: 'fourth',
        intent: { ...intent, anidbId: 44 }, nowMs: 4 }); }
      finally { requests.close(); }
      assert.deepEqual(queue.claimNext(), { state: 'claimed', requestId: 4, pass: 1 });
    } finally { queue.close(); }
  }));

test('overlapping ticks do not claim twice and invalid results never report progress', async () =>
  fixture(async (dbPath) => {
    const queue = openAcquisitionRequestQueue(dbPath);
    let release;
    const worker = createAcquisitionPageWorker({ queue, limit: 1, now: () => 200,
      processRequest: () => new Promise((resolve) => { release = resolve; }) });
    try {
      const first = worker.runOnce();
      assert.deepEqual(await worker.runOnce(), { state: 'held', reason: 'page_in_progress' });
      release({ state: 'available' });
      assert.deepEqual(await first, { state: 'page', results: [{ requestId: 1,
        state: 'held', reason: 'worker_unavailable', nextDueMs: 1_800_200 }] });
      assert.equal(queue.getResult(1).reason, 'worker_unavailable');
      assert.equal(queue.claimNext().requestId, 2);
    } finally { queue.close(); }
  }));

test('restart recovery releases only claims with no saved acquisition attempt', async () =>
  fixture(async (dbPath) => {
    const queue = openAcquisitionRequestQueue(dbPath);
    try {
      for (let id = 1; id <= 3; id++) queue.claimNext({ nowMs: 100 });
      const seen = [];
      const recovered = await reconcileUnresolvedAcquisitionClaims({ queue,
        inspectRequest: async (requestId) => {
          seen.push(requestId);
          return requestId === 2 ? { state: 'attempt_present' } :
            requestId === 3 ? { state: 'unavailable' } : { state: 'no_attempt' };
        }, now: () => 200, limit: 3 });
      assert.deepEqual(seen, [1, 2, 3]);
      assert.deepEqual(recovered, { state: 'reviewed', resolved: [1, 2], held: [3] });
      assert.equal(queue.getResult(1).reason, 'reconciled_no_dispatch');
      assert.equal(queue.getResult(2).reason, 'interrupted_attempt_present');
      assert.equal(queue.getResult(2).nextDueMs, null);
      assert.deepEqual(queue.listUnresolved().map((item) => item.requestId), [3]);
      assert.deepEqual(await reconcileUnresolvedAcquisitionClaims({ queue,
        inspectRequest: () => ({ state: 'no_attempt' }), now: () => 201,
        limit: 2 }), { state: 'reviewed', resolved: [3], held: [] });
    } finally { queue.close(); }
  }));

test('an interrupted request with only a released unsent reservation can retry', async () =>
  fixture(async (dbPath) => {
    const acquisitions = openAcquisitionLedger(dbPath);
    const queue = openAcquisitionRequestQueue(dbPath);
    try {
      const reserved = acquisitions.reserve({ requestId: 1,
        candidate: { indexerId: 7, guid: 'released-only' },
        episodeIds: [1001], nowMs: 100 });
      assert.equal(reserved.state, 'reserved');
      assert.equal(acquisitions.releaseReserved({ attemptId: reserved.attemptId,
        nowMs: 101 }).state, 'released_pre_dispatch');
      queue.claimNext({ nowMs: 200 });
      await reconcileUnresolvedAcquisitionClaims({ queue,
        inspectRequest: (id) => acquisitions.inspectRequestAttempts(id),
        now: () => 300 });
      assert.equal(queue.getResult(1).reason, 'reconciled_no_dispatch');
      assert.notEqual(queue.getResult(1).nextDueMs, null);
    } finally { queue.close(); acquisitions.close(); }
  }));

test('restart recovery reviews every page of interrupted requests', async () =>
  fixture(async (dbPath) => {
    const requests = openRequestLedger(dbPath);
    try {
      for (let id = 4; id <= 23; id++) requests.submit({ requesterId: 1,
        requestKey: `request-${id}`, nowMs: id,
        intent: { ...intent, anidbId: 40 + id } });
    } finally { requests.close(); }
    const queue = openAcquisitionRequestQueue(dbPath);
    try {
      for (let id = 1; id <= 23; id++) {
        assert.equal(queue.claimNext({ nowMs: 100 }).requestId, id);
      }
      const inspected = [];
      const recovered = await reconcileUnresolvedAcquisitionClaims({ queue,
        inspectRequest: async (requestId) => {
          inspected.push(requestId);
          return requestId === 21 ? { state: 'attempt_present' } :
            { state: 'no_attempt' };
        }, now: () => 200, limit: 5 });
      assert.deepEqual(inspected, Array.from({ length: 23 }, (_, i) => i + 1));
      assert.deepEqual(recovered.held, []);
      assert.equal(recovered.resolved.length, 23);
      assert.equal(queue.getResult(21).reason, 'interrupted_attempt_present');
      assert.deepEqual(queue.listUnresolved().map((row) => row.requestId), []);
    } finally { queue.close(); }
  }));

test('a held request resumes its next candidate batch after a restart', async () =>
  fixture(async (dbPath) => {
    const fingerprint = `${'a'.repeat(64)}:${'b'.repeat(64)},${'c'.repeat(64)}`;
    let queue = openAcquisitionRequestQueue(dbPath);
    try {
      const claim = queue.claimNext({ nowMs: 100 });
      assert.equal(claim.requestId, 1);
      assert.deepEqual(queue.recordResult({ requestId: 1, pass: claim.pass,
        state: 'held', reason: 'no_safe_release',
        nextCandidateOffset: 3, nextCandidateFingerprint: fingerprint,
        checkedMs: 100 }), { state: 'recorded' });
      assert.equal(queue.getResult(1).candidateOffset, 3);
      assert.equal(queue.getResult(1).candidateFingerprint, fingerprint);
    } finally { queue.close(); }
    queue = openAcquisitionRequestQueue(dbPath);
    try {
      for (let id = 2; id <= 3; id++) {
        const claim = queue.claimNext({ nowMs: 1_800_100 });
        assert.equal(claim.requestId, id);
        queue.recordResult({ requestId: id, pass: claim.pass,
          state: 'held', reason: 'not_ready', checkedMs: 1_800_100 });
      }
      assert.equal(queue.claimNext({ nowMs: 1_800_100 }).state, 'pass_complete');
      const resumed = queue.claimNext({ nowMs: 1_800_100 });
      assert.deepEqual(resumed, { state: 'claimed', requestId: 1,
        pass: 2, candidateOffset: 3, candidateFingerprint: fingerprint });
    } finally { queue.close(); }
  }));

test('the page worker passes a saved candidate offset to a later attempt', async () =>
  fixture(async (dbPath) => {
    const queue = openAcquisitionRequestQueue(dbPath);
    const seen = [];
    try {
      const worker = createAcquisitionPageWorker({ queue, limit: 3,
        now: () => 100,
        processRequest: async ({ requestId, candidateOffset, candidateFingerprint }) => {
          seen.push({ requestId, candidateOffset, candidateFingerprint });
          return { state: 'held', reason: 'no_safe_release',
            nextCandidateOffset: requestId === 1 ? 3 : 0,
            nextCandidateFingerprint: requestId === 1 ?
              `${'b'.repeat(64)}:${'c'.repeat(64)}|${'d'.repeat(64)}` : undefined };
        } });
      const page = await worker.runOnce();
      assert.equal(page.state, 'page');
      assert.equal(page.results[0].continuationDueMs, 100);
      assert.equal((await worker.runOnce()).state, 'pass_complete');
      const later = createAcquisitionPageWorker({ queue, limit: 1,
        now: () => 1_800_100,
        processRequest: async ({ requestId, candidateOffset, candidateFingerprint }) => {
          seen.push({ requestId, candidateOffset, candidateFingerprint });
          return { state: 'held', reason: 'no_safe_release' };
        } });
      assert.equal((await later.runOnce()).state, 'page');
      assert.deepEqual(seen.at(-1), { requestId: 1, candidateOffset: 3,
        candidateFingerprint: `${'b'.repeat(64)}:${'c'.repeat(64)}|${'d'.repeat(64)}` });
    } finally { queue.close(); }
  }));

test('existing queue databases acquire the candidate position without losing checks', async () =>
  fixture(async (dbPath) => {
    const old = new DatabaseSync(dbPath);
    old.exec(`CREATE TABLE acquisition_request_checks (
      request_id INTEGER PRIMARY KEY REFERENCES requests(id),
      pass INTEGER NOT NULL, state TEXT, reason TEXT, attempt_id INTEGER,
      checked_ms INTEGER, next_due_ms INTEGER) STRICT`);
    old.prepare(`INSERT INTO acquisition_request_checks
      VALUES (1,1,'held','not_ready',NULL,100,1800100)`).run();
    old.close();
    const queue = openAcquisitionRequestQueue(dbPath);
    try {
      assert.equal(queue.getResult(1).reason, 'not_ready');
      assert.equal(queue.claimNext({ nowMs: 101 }).requestId, 2);
    } finally { queue.close(); }
  }));


test('self-stale and import-evidence retries are short and migrate existing long due rows',async()=>fixture(async dbPath=>{
 for(const reason of ['availability_evidence_stale','import_activity_unverified']){
  let q=openAcquisitionRequestQueue(dbPath);const claim=q.claimNext({nowMs:100});q.recordResult({requestId:claim.requestId,pass:claim.pass,state:'held',reason,checkedMs:101});assert.equal(q.getResult(claim.requestId).nextDueMs,60101);q.close();
  const db=new DatabaseSync(dbPath);db.prepare('UPDATE acquisition_request_checks SET next_due_ms=1800101 WHERE request_id=?').run(claim.requestId);db.close();q=openAcquisitionRequestQueue(dbPath);assert.equal(q.getResult(claim.requestId).nextDueMs,60101);q.close();
  const reset=new DatabaseSync(dbPath);reset.exec('DELETE FROM acquisition_request_checks');reset.close();
 }
}));

test('Auto-Pick delegation gets one immediate turn after an empty search and survives restart',async()=>fixture(async dbPath=>{
 let queue=openAcquisitionRequestQueue(dbPath);const db=new DatabaseSync(dbPath);
 try{
  const claim=queue.claimNext({nowMs:100,priorityRequestId:1});queue.recordResult({requestId:1,pass:claim.pass,state:'held',reason:'no_safe_release',checkedMs:100});
  db.prepare('UPDATE requests SET release_control=? WHERE id=1').run(JSON.stringify({mode:'auto',phase:'consumed',revision:2}));
  queue.close();queue=openAcquisitionRequestQueue(dbPath);
  const next=queue.claimNext({nowMs:101,priorityRequestId:1});assert.equal(next.requestId,1);
  queue.recordResult({requestId:1,pass:next.pass,state:'held',reason:'no_safe_release',checkedMs:102});
  assert.notEqual(queue.claimNext({nowMs:103,priorityRequestId:1}).requestId,1);
 }finally{db.close();queue.close();}
}));
