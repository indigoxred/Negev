import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openPendingTitleLedger } from '../src/requests/pending-title-ledger.mjs';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';

async function withPath(run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-pending-title-'));
  try { await run(path.join(dir, 'requests.sqlite')); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

const first = { requesterId: 7, anidbId: 4158,
  title: 'Pale Cocoon', requestKey: 'cold-one', nowMs: 1_000 };

test('pending title intent survives restart and one key never changes its title',
  async () => withPath(async (dbPath) => {
    const ledger = openPendingTitleLedger(dbPath);
    const saved = ledger.enqueue(first);
    assert.deepEqual(saved, { state: 'pending', intentId: 1, created: true });
    ledger.close();

    const reopened = openPendingTitleLedger(dbPath);
    try {
      assert.deepEqual(reopened.get(1), { id: 1, ...first,
        state: 'pending', nextDueMs: 1_000, leaseUntilMs: null,
        version: 0, attempts: 0, normalRequestId: null, reason: null });
      assert.deepEqual(reopened.enqueue({ ...first, nowMs: 2_000 }),
        { state: 'pending', intentId: 1, created: false });
      assert.deepEqual(reopened.enqueue({ ...first, anidbId: 4159,
        nowMs: 2_000 }), { state: 'held', reason: 'idempotency_key_conflict' });
      assert.deepEqual(reopened.enqueue({ ...first, requesterId: 8,
        nowMs: 2_000 }), { state: 'pending', intentId: 2, created: true });
    } finally { reopened.close(); }
  }));

test('only a due intent can be claimed; cancellation and stale workers cannot resolve it',
  async () => withPath(async (dbPath) => {
    const ledger = openPendingTitleLedger(dbPath);
    try {
      ledger.enqueue(first);
      const claim = ledger.claimDue({ nowMs: 1_000, leaseMs: 5_000 });
      assert.equal(claim.id, 1);
      assert.equal(claim.state, 'resolving');
      assert.equal(claim.version, 1);
      assert.equal(ledger.claimDue({ nowMs: 1_001, leaseMs: 5_000 }), null);
      assert.deepEqual(ledger.cancel({ requesterId: 7, intentId: 1,
        nowMs: 1_002 }), { state: 'held', reason: 'resolution_in_progress' });
      assert.deepEqual(ledger.defer({ intentId: 1, version: 1,
        nowMs: 1_003, delayMs: 30_000, reason: 'detail_pending' }),
      { state: 'pending', nextDueMs: 31_003 });
      assert.equal(ledger.claimDue({ nowMs: 31_002, leaseMs: 5_000 }), null);
      assert.deepEqual(ledger.cancel({ requesterId: 7, intentId: 1,
        nowMs: 31_002 }), { state: 'cancelled', intentId: 1 });
      assert.deepEqual(ledger.finish({ intentId: 1, version: 1,
        normalRequestId: 12, nowMs: 31_003 }),
      { state: 'held', reason: 'stale_claim' });
      assert.equal(ledger.claimDue({ nowMs: 40_000, leaseMs: 5_000 }), null);
    } finally { ledger.close(); }
  }));

test('expired claim can be recovered and a normal request is recorded once',
  async () => withPath(async (dbPath) => {
    const ledger = openPendingTitleLedger(dbPath);
    try {
      ledger.enqueue(first);
      assert.equal(ledger.claimDue({ nowMs: 1_000, leaseMs: 5_000 }).version, 1);
      assert.equal(ledger.claimDue({ nowMs: 5_999, leaseMs: 5_000 }), null);
    } finally { ledger.close(); }
    const reopened = openPendingTitleLedger(dbPath);
    try {
      const claim = reopened.claimDue({ nowMs: 6_000, leaseMs: 5_000 });
      assert.equal(claim.version, 2);
      assert.deepEqual(reopened.finish({ intentId: 1, version: 1,
        normalRequestId: 12, nowMs: 6_001 }),
      { state: 'held', reason: 'stale_claim' });
      assert.deepEqual(reopened.finish({ intentId: 1, version: 2,
        normalRequestId: 12, nowMs: 6_002 }),
      { state: 'resolved', intentId: 1, normalRequestId: 12 });
      assert.equal(reopened.claimDue({ nowMs: 12_000, leaseMs: 5_000 }), null);
      assert.deepEqual(reopened.enqueue({ ...first, nowMs: 12_000 }),
        { state: 'resolved', intentId: 1, normalRequestId: 12,
          created: false });
    } finally { reopened.close(); }
  }));

test('a pending title creates no normal request or acquisition target',
  async () => withPath(async (dbPath) => {
    const requests = openRequestLedger(dbPath);
    const pending = openPendingTitleLedger(dbPath);
    try {
      pending.enqueue(first);
      assert.equal(requests.countRequests(), 0);
      assert.equal(requests.countTargets(), 0);
    } finally { pending.close(); requests.close(); }
  }));
