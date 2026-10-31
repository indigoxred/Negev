import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { openAcquisitionRequestQueue, createAcquisitionPageWorker,
  reconcileUnresolvedAcquisitionClaims } from
  '../src/acquisition/acquisition-request-queue.mjs';

const intent = { state: 'ready', anidbId: 42, kind: 'series',
  episodeIds: [1001], monitorFuture: false };

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
    try {
      const worker = createAcquisitionPageWorker({ queue, limit: 3, now: () => 100,
        processRequest: async ({ requestId }) => {
          seen.push(requestId);
          if (requestId === 1) return { state: 'held', reason: 'shoko_unrecognized' };
          if (requestId === 2) throw Error('private provider detail');
          return { state: 'stopped_observed', attemptId: 77 };
        } });
      const page = await worker.runOnce();
      assert.equal(page.state, 'page');
      assert.deepEqual(seen, [1, 2, 3]);
      assert.deepEqual(page.results.map((result) => result.state),
        ['held', 'held', 'stopped_observed']);
      assert.deepEqual(queue.getResult(1), { requestId: 1, pass: 1, attemptId: null,
        state: 'held', reason: 'shoko_unrecognized', checkedMs: 100,
        nextDueMs: 1_800_100 });
      assert.deepEqual(queue.getResult(2), { requestId: 2, pass: 1, attemptId: null,
        state: 'held', reason: 'worker_unavailable', checkedMs: 100,
        nextDueMs: 1_800_100 });
      assert.deepEqual(await worker.runOnce(), { state: 'pass_complete', pass: 1, results: [] });
      assert.deepEqual(await worker.runOnce(), { state: 'pass_complete', pass: 2, results: [] });
      assert.deepEqual(queue.claimNext({ nowMs: 1_800_100 }),
        { state: 'claimed', requestId: 1, pass: 3 });
      assert.equal(queue.getResult(3).attemptId, 77);
    } finally { queue.close(); }
  }));

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
        state: 'held', reason: 'worker_unavailable' }] });
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
      assert.deepEqual(recovered, { state: 'reviewed', resolved: [1], held: [2, 3] });
      assert.equal(queue.getResult(1).reason, 'reconciled_no_dispatch');
      assert.equal(queue.getResult(2).state, null);
      assert.deepEqual(queue.listUnresolved().map((item) => item.requestId), [2, 3]);
      assert.deepEqual(await reconcileUnresolvedAcquisitionClaims({ queue,
        inspectRequest: () => ({ state: 'no_attempt' }), now: () => 201,
        limit: 2 }), { state: 'reviewed', resolved: [2, 3], held: [] });
    } finally { queue.close(); }
  }));

test('a held request resumes its next candidate batch after a restart', async () =>
  fixture(async (dbPath) => {
    let queue = openAcquisitionRequestQueue(dbPath);
    try {
      const claim = queue.claimNext({ nowMs: 100 });
      assert.equal(claim.requestId, 1);
      assert.deepEqual(queue.recordResult({ requestId: 1, pass: claim.pass,
        state: 'held', reason: 'no_safe_release',
        nextCandidateOffset: 3, checkedMs: 100 }), { state: 'recorded' });
      assert.equal(queue.getResult(1).candidateOffset, 3);
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
        pass: 2, candidateOffset: 3 });
    } finally { queue.close(); }
  }));

test('the page worker passes a saved candidate offset to a later attempt', async () =>
  fixture(async (dbPath) => {
    const queue = openAcquisitionRequestQueue(dbPath);
    const seen = [];
    try {
      const worker = createAcquisitionPageWorker({ queue, limit: 3,
        now: () => 100,
        processRequest: async ({ requestId, candidateOffset }) => {
          seen.push({ requestId, candidateOffset });
          return { state: 'held', reason: 'no_safe_release',
            nextCandidateOffset: requestId === 1 ? 3 : 0 };
        } });
      assert.equal((await worker.runOnce()).state, 'page');
      assert.equal((await worker.runOnce()).state, 'pass_complete');
      const later = createAcquisitionPageWorker({ queue, limit: 1,
        now: () => 1_800_100,
        processRequest: async ({ requestId, candidateOffset }) => {
          seen.push({ requestId, candidateOffset });
          return { state: 'held', reason: 'no_safe_release' };
        } });
      assert.equal((await later.runOnce()).state, 'page');
      assert.deepEqual(seen.at(-1), { requestId: 1, candidateOffset: 3 });
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
