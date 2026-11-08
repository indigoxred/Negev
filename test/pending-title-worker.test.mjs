import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openPendingTitleLedger } from '../src/requests/pending-title-ledger.mjs';
import { createPendingTitleWorker } from '../src/requests/pending-title-worker.mjs';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { createHeldRequestSubmitter } from '../src/requests/submit-held-request.mjs';

async function withLedger(run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-pending-worker-'));
  const dbPath = path.join(dir, 'requests.sqlite');
  const ledger = openPendingTitleLedger(dbPath);
  try { await run({ ledger, dbPath }); }
  finally { ledger.close(); await rm(dir, { recursive: true, force: true }); }
}
const item = { requesterId: 4, anidbId: 4158,
  title: 'Pale Cocoon', requestKey: 'cold-key', nowMs: 1_000 };

test('pending detail schedules preparation and later resolves with the original key',
  async () => withLedger(async ({ ledger }) => {
    ledger.enqueue(item);
    let nowMs = 1_000;
    let ready = false;
    const submissions = [];
    const prepared = [];
    const worker = createPendingTitleWorker({ ledger, now: () => nowMs,
      authorize: async () => true,
      prepareDetail: async (input) => { prepared.push(input); },
      submitRequest: async (input) => {
        submissions.push(input);
        return ready ? { state: 'held', requestId: 27,
          reason: 'awaiting_availability_evidence' } :
          { state: 'held', reason: 'detail_pending' };
      } });
    assert.deepEqual(await worker.runOnce(), { state: 'pending', intentId: 1,
      reason: 'detail_pending', nextDueMs: 31_000 });
    assert.deepEqual(prepared, [{ anidbId: 4158 }]);
    assert.equal((await worker.runOnce()).state, 'idle');
    nowMs = 31_000;
    ready = true;
    assert.deepEqual(await worker.runOnce(), { state: 'resolved', intentId: 1,
      requestId: 27 });
    assert.deepEqual(submissions, [
      { requesterId: 4, anidbId: 4158, scope: 'installment',
        requestKey: 'cold-key' },
      { requesterId: 4, anidbId: 4158, scope: 'installment',
        requestKey: 'cold-key' },
    ]);
    assert.equal((await worker.runOnce()).state, 'idle');
  }));

test('a long provider outage stays visible, retries at a bounded pace, and does not block another title',
  async () => withLedger(async ({ ledger }) => {
    ledger.enqueue(item);
    ledger.enqueue({ ...item, requesterId: 5, anidbId: 4159,
      title: 'Other title', requestKey: 'other' });
    let nowMs = 1_000;
    const worker = createPendingTitleWorker({ ledger, now: () => nowMs,
      authorize: async () => true,
      submitRequest: async ({ anidbId }) => anidbId === 4158
        ? { state: 'held', reason: 'detail_unavailable' }
        : { state: 'held', requestId: 44 },
    });
    let result = await worker.runOnce();
    assert.equal(result.state, 'pending');
    assert.equal((await worker.runOnce()).requestId, 44);
    for (let attempt = 0; attempt < 20; attempt++) {
      nowMs = result.nextDueMs;
      result = await worker.runOnce();
      assert.equal(result.state, 'pending');
    }
    assert.equal(result.nextDueMs - nowMs, 600_000);
    assert.equal(ledger.get(1).state, 'pending');
    assert.equal(ledger.get(2).state, 'resolved');
  }));

test('a full library match finishes without creating a normal request',
  async () => withLedger(async ({ ledger }) => {
    ledger.enqueue(item);
    const worker = createPendingTitleWorker({ ledger, now: () => 1_000,
      authorize: async () => true,
      submitRequest: async () => ({ state: 'held', reason: 'already_available' }) });
    assert.deepEqual(await worker.runOnce(), { state: 'complete', intentId: 1,
      reason: 'already_available' });
    assert.equal(ledger.get(1).normalRequestId, null);
    assert.equal((await worker.runOnce()).state, 'idle');
  }));

test('an ambiguous movie ends preparation so the user can select a part',
  async () => withLedger(async ({ ledger }) => {
    ledger.enqueue(item);
    const worker = createPendingTitleWorker({ ledger, now: () => 1_000,
      authorize: async () => true,
      submitRequest: async () => ({ state: 'held',
        reason: 'ambiguous_movie_scope' }) });
    assert.deepEqual(await worker.runOnce(), { state: 'complete', intentId: 1,
      reason: 'ambiguous_movie_scope' });
    assert.equal((await worker.runOnce()).state, 'idle');
  }));

test('a cancelled intent is never submitted and another due intent advances',
  async () => withLedger(async ({ ledger }) => {
    ledger.enqueue(item);
    ledger.enqueue({ ...item, requesterId: 5, requestKey: 'another' });
    ledger.cancel({ requesterId: 4, intentId: 1, nowMs: 1_001 });
    const submitted = [];
    const worker = createPendingTitleWorker({ ledger, now: () => 1_001,
      authorize: async () => true,
      submitRequest: async (input) => {
        submitted.push(input);
        return { state: 'held', requestId: 29 };
      } });
    assert.deepEqual(await worker.runOnce(), { state: 'resolved', intentId: 2,
      requestId: 29 });
    assert.deepEqual(submitted.map((row) => row.requesterId), [5]);
  }));

test('a crash after exact submission reuses the same request key',
  async () => withLedger(async ({ ledger, dbPath }) => {
    ledger.enqueue(item);
    const firstClaim = ledger.claimDue({ nowMs: 1_000, leaseMs: 300_000 });
    assert.equal(firstClaim.version, 1);
    const reopened = openPendingTitleLedger(dbPath);
    try {
      let calls = 0;
      const worker = createPendingTitleWorker({ ledger: reopened,
        authorize: async () => true,
        now: () => 301_000, submitRequest: async (input) => {
          calls++;
          assert.equal(input.requestKey, item.requestKey);
          return { state: 'held', requestId: 32, created: false };
        } });
      assert.deepEqual(await worker.runOnce(), { state: 'resolved', intentId: 1,
        requestId: 32 });
      assert.equal(calls, 1);
    } finally { reopened.close(); }
  }));

test('real exact submitter creates one completed film target only after detail arrives',
  async () => withLedger(async ({ ledger, dbPath }) => {
    const requests = openRequestLedger(dbPath);
    try {
      ledger.enqueue(item);
      let ready = false;
      let nowMs = 1_000;
      const submitRequest = createHeldRequestSubmitter({
        confirmKnownTitle: async () => true,
        loadDetail: async () => ready ? { state: 'details', anidbId: 4158,
          title: 'Pale Cocoon', kind: 'movie', restricted: false,
          complete: true, page: 1, total: 1, nextPage: null,
          airDate: '2005-11-01', endDate: '2005-11-01',
          episodeCount: 1, episodes: [{ id: 777, number: 1,
            type: 'Episode', title: 'Film', airDate: '2005-11-01' }] } :
          { state: 'detail_pending', anidbId: 4158 },
        ledger: requests, now: () => nowMs,
        today: () => '2026-11-09',
      });
      const worker = createPendingTitleWorker({ ledger,
        authorize: async () => true,
        submitRequest, now: () => nowMs });
      assert.equal((await worker.runOnce()).state, 'pending');
      assert.equal(requests.countRequests(), 0);
      assert.equal(requests.countTargets(), 0);
      nowMs = 31_000;
      ready = true;
      const result = await worker.runOnce();
      assert.equal(result.state, 'resolved');
      assert.deepEqual(requests.getRequest(result.requestId).episodeIds, [777]);
      assert.equal(requests.getRequest(result.requestId).monitorFuture, false);
      assert.equal(requests.countRequests(), 1);
      assert.equal(requests.countTargets(), 1);
    } finally { requests.close(); }
  }));

test('real exact submitter keeps an Airing title watched for future episodes',
  async () => withLedger(async ({ ledger, dbPath }) => {
    const requests = openRequestLedger(dbPath);
    try {
      ledger.enqueue({ ...item, anidbId: 19586,
        title: 'Zombie Sagashitemasu' });
      const submitRequest = createHeldRequestSubmitter({
        confirmKnownTitle: async () => true,
        loadDetail: async () => ({ state: 'details', anidbId: 19586,
          title: 'Zombie Sagashitemasu', kind: 'series', restricted: false,
          complete: true, page: 1, total: 1, nextPage: null,
          airDate: '2026-10-03', endDate: null, episodeCount: 12,
          episodes: [{ id: 317633, number: 6, type: 'Episode',
            title: 'Episode 6', airDate: '2026-11-07' }] }),
        ledger: requests, now: () => 1_000,
        today: () => '2026-11-09',
      });
      const worker = createPendingTitleWorker({ ledger,
        authorize: async () => true,
        submitRequest, now: () => 1_000 });
      const result = await worker.runOnce();
      assert.equal(result.state, 'resolved');
      assert.equal(requests.getRequest(result.requestId).monitorFuture, true);
      assert.deepEqual(requests.getRequest(result.requestId).episodeIds,
        [317633]);
    } finally { requests.close(); }
  }));

test('revoked adult access prevents a queued request from resolving',
  async () => withLedger(async ({ ledger }) => {
    ledger.enqueue(item);
    let submitted = 0;
    const worker = createPendingTitleWorker({ ledger, now: () => 1_000,
      authorize: async ({ requesterId }) => {
        assert.equal(requesterId, 4);
        return false;
      },
      submitRequest: async () => { submitted++; return { state: 'held',
        requestId: 44 }; } });
    assert.deepEqual(await worker.runOnce(), { state: 'complete', intentId: 1,
      reason: 'account_access_changed' });
    assert.equal(submitted, 0);
  }));
