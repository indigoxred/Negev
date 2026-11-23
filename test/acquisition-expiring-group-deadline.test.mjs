import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { openAcquisitionRequestQueue, createAcquisitionPageWorker,
  reconcileUnresolvedAcquisitionClaims } from '../src/acquisition/acquisition-request-queue.mjs';
import { createPipelineScheduler } from '../src/acquisition/acquisition-pipeline-scheduler.mjs';

async function fixture(run, count = 1) {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-expiring-group-deadline-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const requests = openRequestLedger(dbPath);
  for (let id = 1; id <= count; id++) requests.submit({ requesterId: 1,
    requestKey: `deadline-${id}`, nowMs: 1,
    intent: { state: 'ready', anidbId: 40 + id, kind: 'series',
      episodeIds: [1000 + id], monitorFuture: false } });
  requests.close();
  try { await run(dbPath); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

for (const retryAtMs of [150, 200, 300]) {
  test(`preferred-group deadline ${retryAtMs} records at 200 and remains durable`,
    () => fixture(async dbPath => {
      let queue = openAcquisitionRequestQueue(dbPath);
      try {
        const claim = queue.claimNext({ nowMs: 100 });
        assert.deepEqual(queue.recordResult({ requestId: 1, pass: claim.pass,
          state: 'held', reason: 'preferred_group_wait', retryAtMs, checkedMs: 200 }),
        { state: 'recorded' });
        assert.equal(queue.getResult(1).nextDueMs, Math.max(200, retryAtMs));
        assert.deepEqual(queue.listUnresolved(), []);
        assert.deepEqual(queue.recordResult({ requestId: 1, pass: claim.pass,
          state: 'held', reason: 'preferred_group_wait', retryAtMs, checkedMs: 200 }),
        { state: 'held', reason: 'stale_claim' });
        queue.close(); queue = openAcquisitionRequestQueue(dbPath);
        assert.equal(queue.getResult(1).nextDueMs, Math.max(200, retryAtMs));
        if (retryAtMs > 200) {
          assert.equal(queue.claimNext({ nowMs: 200, priorityRequestId: 1 }).state,
            'pass_complete');
        }
        assert.equal(queue.claimNext({ nowMs: Math.max(200, retryAtMs),
          priorityRequestId: 1 }).requestId, 1);
      } finally { queue.close(); }
    }));
}

test('malformed and excessive deadlines preserve the active claim for guarded recovery',
  () => fixture(async dbPath => {
    const queue = openAcquisitionRequestQueue(dbPath);
    try {
      const claim = queue.claimNext({ nowMs: 100 });
      for (const retryAtMs of [-1, 1.5, NaN, Infinity, '150', 7_200_201,
        Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => queue.recordResult({ requestId: 1, pass: claim.pass,
          state: 'held', reason: 'preferred_group_wait', retryAtMs, checkedMs: 200 }),
        /Invalid acquisition check result/);
        assert.equal(queue.getResult(1).state, null);
      }
      assert.deepEqual(queue.listUnresolved(), [{ requestId: 1, pass: claim.pass }]);
    } finally { queue.close(); }
  }));

test('a deadline crossing during real worker processing continues through the scheduler',
  () => fixture(async dbPath => {
    const queue = openAcquisitionRequestQueue(dbPath);
    let nowMs = 100, timerId = 0, turns = 0;
    const jobs = new Map(), priorities = [];
    const worker = createAcquisitionPageWorker({ queue, limit: 1, now: () => nowMs,
      processRequest: async () => {
        turns++;
        if (turns === 1) {
          const retryAtMs = nowMs + 50;
          nowMs += 100;
          return { state: 'held', reason: 'preferred_group_wait', retryAtMs };
        }
        return { state: 'held', reason: 'request_fully_available' };
      } });
    const idle = async () => ({ state: 'idle' });
    const scheduler = createPipelineScheduler({ now: () => nowMs,
      setTimer: (callback, delay) => { jobs.set(++timerId, { callback, delay }); return timerId; },
      clearTimer: id => jobs.delete(id),
      pipeline: { initialize: async () => ({ state: 'reconciled' }),
        tickCompletions: idle, tickPublish: idle, tickStarts: idle,
        listMetadataRetries: () => queue.listMetadataRetries({ nowMs }),
        tickRequests: options => {
          priorities.push(options?.priorityRequestId);
          return worker.runOnce(options);
        }, close: async () => {} } });
    const advance = async () => {
      const [id, job] = jobs.entries().next().value;
      jobs.delete(id); nowMs += job.delay;
      await job.callback();
      await new Promise(resolve => setImmediate(resolve));
    };
    try {
      await scheduler.start(); scheduler.wakeRequest(1);
      await advance();
      assert.equal(scheduler.getLastResult().state, 'page');
      assert.equal(queue.getResult(1).reason, 'preferred_group_wait');
      assert.equal(queue.getResult(1).nextDueMs, nowMs);
      assert.deepEqual(queue.listUnresolved(), []);
      for (let i = 0; i < 4 && turns < 2; i++) await advance();
      assert.equal(turns, 2);
      assert.deepEqual(priorities, [1, 1]);
      assert.equal(queue.getResult(1).reason, 'request_fully_available');
    } finally { await scheduler.stop(); queue.close(); }
  }));

test('reopening old stranded claims preserves uncertain claims until ledger reconciliation',
  () => fixture(async dbPath => {
    let queue = openAcquisitionRequestQueue(dbPath);
    try {
      const stranded = queue.claimNext({ nowMs: 100 });
      const uncertain = queue.claimNext({ nowMs: 100 });
      queue.close(); queue = openAcquisitionRequestQueue(dbPath);
      assert.equal(queue.claimNext({ nowMs: 500, priorityRequestId: 1 }).state,
        'pass_complete');
      assert.deepEqual(queue.listUnresolved(), [
        { requestId: 1, pass: stranded.pass }, { requestId: 2, pass: uncertain.pass }]);
      const reviewed = await reconcileUnresolvedAcquisitionClaims({ queue,
        now: () => 500, inspectRequest: async requestId => requestId === 1
          ? { state: 'no_attempt' } : { state: 'unavailable' } });
      assert.deepEqual(reviewed, { state: 'reviewed', resolved: [1], held: [2] });
      assert.equal(queue.getResult(2).state, null);
      assert.deepEqual(queue.listUnresolved(), [{ requestId: 2, pass: uncertain.pass }]);
      assert.equal(queue.claimNext({ nowMs: queue.getResult(1).nextDueMs,
        priorityRequestId: 1 }).requestId, 1);
    } finally { queue.close(); }
  }, 2));

// Exercise a genuine pre-fix durable writer rather than handcrafting its check row.
for (const legacyPhase of ['chosen', 'consumed']) test('legacy ' + legacyPhase + ' subset terminal decisions reopen once while complete, guarded and live rows survive',
  async () => {
    const { createHash } = await import('node:crypto');
    const { readFile, writeFile } = await import('node:fs/promises');
    const { pathToFileURL } = await import('node:url');
    const { DatabaseSync } = await import('node:sqlite');
    const dir = await mkdtemp(path.join(tmpdir(), 'negev-old-subset-terminal-'));
    const dbPath = path.join(dir, 'state.sqlite');
    // Verbatim git show v0.0.309:src/acquisition/acquisition-request-queue.mjs.
    // Frozen inert test data keeps this real historical writer usable in images
    // and shallow CI checkouts without a Git executable or repository history.
    const oldBytes = await readFile(new URL('./fixtures/acquisition-request-queue-v309.mjs.txt', import.meta.url));
    assert.equal(createHash('sha256').update(oldBytes).digest('hex'),
      '81e3a4ae470325062f6f28b51f14e41549e4ec43e125176027e5f0a43fb827d9');
    const oldSource = oldBytes.toString('utf8');
    const oldModule = path.join(dir, 'queue-v309.mjs');
    await writeFile(oldModule, oldSource.replace("'./preferred-release.mjs'",
      JSON.stringify(new URL('../src/acquisition/preferred-release.mjs', import.meta.url).href)));
    const { openAcquisitionRequestQueue: openOldQueue } = await import(pathToFileURL(oldModule));
    const requests = openRequestLedger(dbPath);
    for (let id = 1; id <= 8; id++) {
      const saved = requests.submit({ requesterId: 1, requestKey: `old-subset-${id}`,
        nowMs: 1, intent: { state: 'ready', anidbId: 42, kind: 'series',
          episodeIds: [1001, 1002, 1003], monitorFuture: false } });
      assert.equal(saved.requestId, id);
      if (id === 6) continue; // no retained selection evidence
      const episodeIds = id === 2 ? [1001, 1002, 1003] : [1001];
      const control = requests.getReleaseControl(id, 1);
      assert.equal(requests.updateReleaseControl(id, control.revision, {
        mode: 'auto', phase: 'chosen', selection: {
          candidate: { guid: `old-release-${id}`, indexerId: 1,
            title: 'Example 01', size: 1000, seeders: 1 },
          preview: { torrentHash: 'a'.repeat(40), episodeIds,
            files: [{ name: 'Example.mkv', size: 1000, episodeIds }] } }
      }, 2).state, 'updated');
    }
    let queue = openOldQueue(dbPath);
    const db = new DatabaseSync(dbPath);
    try {
      for (let id = 1; id <= 8; id++) {
        const claim = queue.claimNext({ nowMs: 100, priorityRequestId: id });
        assert.equal(claim.requestId, id);
        if (id === 5) continue; // an unresolved/live claim must remain excluded
        queue.recordResult({ requestId: id, pass: claim.pass, state: 'held',
          reason: 'request_fully_available', checkedMs: 200,
          nextCandidateOffset: 2, nextCandidateFingerprint: 'a'.repeat(64) });
      }
      assert.equal(queue.suspendUnstarted({ requestId: 4, reason: 'review', nowMs: 201 }).state,
        'suspended');
      db.prepare('UPDATE requests SET cancelled_ms=201 WHERE id=3').run();
      for (const [id, episodeIds] of [[7, [1001, 1001]], [8, [9999]]]) {
        const control = JSON.parse(db.prepare('SELECT release_control FROM requests WHERE id=?').get(id).release_control);
        control.selection.preview.episodeIds = episodeIds;
        db.prepare('UPDATE requests SET release_control=? WHERE id=?').run(JSON.stringify(control), id);
      }
      if (legacyPhase === 'consumed') for (const id of [1, 4]) assert.equal(requests.consumeReleaseChoice(id, requests.getReleaseControl(id, 201).revision), true);
      const originalSuspension = queue.getSuspension(4);
      const before = new Map(Array.from({ length: 8 }, (_, i) => [i + 1, queue.getResult(i + 1)]));
      queue.close(); queue = openAcquisitionRequestQueue(dbPath);
      const reopened = queue.getResult(1);
      assert.equal(reopened.reason, 'request_scope_recheck');
      assert.equal(reopened.nextDueMs, 0);
      assert.equal(reopened.candidateOffset, undefined);
      assert.equal(reopened.candidateFingerprint, undefined);
      assert.equal(queue.getDecisionTiming(1), null);
      for (let id = 2; id <= 8; id++) if (id !== 4) assert.deepEqual(queue.getResult(id), before.get(id));
      assert.deepEqual(queue.getSuspension(4), originalSuspension);
      assert.equal(queue.getResult(4).reason, 'request_scope_recheck');
      assert.equal(queue.getResult(4).nextDueMs, 0);
      assert.equal(db.prepare('SELECT request_scope_policy_revision AS revision FROM acquisition_request_checks WHERE request_id=1').get().revision, 1);
      const { createAcquisitionRequestProcessor } = await import('../src/acquisition/acquisition-request-processor.mjs');
      let available = [1001], nowMs = 300;
      const scopes = [], submits = [];
      const process = createAcquisitionRequestProcessor({
        readRequest: id => requests.getRequest(id),
        readReleaseControl: (id, now) => requests.getReleaseControl(id, now),
        consumeReleaseChoice: (id, revision) => requests.consumeReleaseChoice(id, revision),
        readPublicCoverage: async request => {
          scopes.push([...request.episodeIds]);
          return { verifiedTargets: available.length, targetCount: 3,
            availableEpisodeIds: available, uncertainEpisodeIds: [] };
        },
        discoverCandidates: async () => ({ state: 'candidates', requestId: 1, anidbId: 42,
          items: [{ guid: 'remaining-release', indexerId: 1, title: 'Example - 02',
            size: 1000, seeders: 10, evidence: 'unverified' }] }),
        previewCandidate: async () => ({ state: 'preflight', requestId: 1, anidbId: 42,
          torrentHash: 'b'.repeat(40), episodeIds: [1002],
          files: [{ name: 'Example - 02.mkv', size: 1000, episodeIds: [1002] }] }),
        loadDetail: async () => ({ state: 'details', complete: true, total: 3,
          page: 1, anidbId: 42, title: 'Example', kind: 'series', restricted: false,
          episodes: [1, 2, 3].map(number => ({ id: 1000 + number, number, type: 'Episode' })) }),
        submitCandidate: async input => { submits.push(input); return { state: 'stopped_observed', attemptId: 91 }; },
        now: () => nowMs });
      const worker = createAcquisitionPageWorker({ queue, processRequest: process,
        now: () => nowMs, limit: 1 });
      const resumed = await worker.runOnce({ priorityRequestId: 1 });
      assert.equal(resumed.results[0].state, 'stopped_observed', JSON.stringify(resumed));
      assert.deepEqual(scopes, [[1001, 1002, 1003]]);
      assert.deepEqual(submits[0].episodeIds, [1002]);
      assert.deepEqual(requests.getRequest(1).episodeIds, [1001, 1002, 1003]);
      // A fresh full-scope proof settles it again despite the retained subset choice.
      available = [1001, 1002, 1003]; nowMs = 60_300;
      const finished = await worker.runOnce({ priorityRequestId: 1 });
      assert.equal(finished.results[0].reason, 'request_fully_available');
      queue.close(); queue = openAcquisitionRequestQueue(dbPath);
      assert.equal(queue.getResult(1).reason, 'request_fully_available');
      assert.equal(queue.claimNext({ nowMs: 10_000_000, priorityRequestId: 1 }).state,
        'pass_complete');
      // Repaired cache must not bypass a suspension. Explicit resume must then
      // expose the saved whole-request recheck instead of stranding it forever.
      assert.deepEqual(queue.getSuspension(4), originalSuspension);
      assert.equal(queue.claimNext({ nowMs: 10_000_000, priorityRequestId: 4 }).state,
        'pass_complete');
      assert.deepEqual(queue.resumeSuspended({ requestId: 4 }), { state: 'resumed' });
      assert.equal(queue.claimNext({ nowMs: 10_000_000, priorityRequestId: 4 }).requestId, 4);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM request_targets').get().count, 24);
    } finally { db.close(); queue.close(); requests.close(); await rm(dir, { recursive: true, force: true }); }
  });
