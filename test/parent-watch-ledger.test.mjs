import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openParentWatchLedger } from '../src/requests/parent-watch-ledger.mjs';

async function withPath(run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-parent-watch-'));
  try { await run(path.join(dir, 'negev.sqlite')); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

test('a parent watch persists, retries idempotently, and rejects a changed source', async () =>
  withPath(async (dbPath) => {
    const first = openParentWatchLedger(dbPath);
    const input = { tvdbId: 123, requesterId: 7, sourceSeriesId: 42, nowMs: 1000 };
    assert.deepEqual(first.adopt(input), { state: 'adopted', created: true });
    assert.deepEqual(first.adopt(input), { state: 'adopted', created: false });
    assert.deepEqual(first.adopt({ ...input, sourceSeriesId: 43 }),
      { state: 'held', reason: 'parent_source_conflict' });
    first.close();
    const second = openParentWatchLedger(dbPath);
    try {
      assert.deepEqual(second.listActive({ limit: 10 }), [{ tvdbId: 123,
        requesterId: 7, sourceSeriesId: 42 }]);
    } finally { second.close(); }
  }));

test('pausing a parent removes it from reconciliation but preserves its history', async () =>
  withPath(async (dbPath) => {
    const ledger = openParentWatchLedger(dbPath);
    try {
      ledger.adopt({ tvdbId: 123, requesterId: 7, sourceSeriesId: 42, nowMs: 1000 });
      assert.deepEqual(ledger.recordInstallment({ tvdbId: 123, anidbId: 987,
        requestId: 55, nowMs: 1100 }), { state: 'recorded', created: true });
      assert.deepEqual(ledger.pause({ tvdbId: 123, nowMs: 1200 }),
        { state: 'paused' });
      assert.deepEqual(ledger.listActive({ limit: 10 }), []);
      assert.deepEqual(ledger.listInstallments({ tvdbId: 123 }), [
        { anidbId: 987, requestId: 55 },
      ]);
      assert.deepEqual(ledger.recordInstallment({ tvdbId: 123, anidbId: 988,
        requestId: 56, nowMs: 1300 }),
      { state: 'held', reason: 'parent_paused' });
      assert.deepEqual(ledger.resume({ tvdbId: 123, nowMs: 1400 }),
        { state: 'active' });
      assert.equal(ledger.listActive({ limit: 10 }).length, 1);
    } finally { ledger.close(); }
  }));

test('one installment cannot be claimed by two parent watches', async () =>
  withPath(async (dbPath) => {
    const ledger = openParentWatchLedger(dbPath);
    try {
      ledger.adopt({ tvdbId: 123, requesterId: 7, sourceSeriesId: 42, nowMs: 1000 });
      ledger.adopt({ tvdbId: 124, requesterId: 7, sourceSeriesId: 43, nowMs: 1000 });
      assert.deepEqual(ledger.recordInstallment({ tvdbId: 123, anidbId: 987,
        requestId: 55, nowMs: 1100 }), { state: 'recorded', created: true });
      assert.deepEqual(ledger.recordInstallment({ tvdbId: 123, anidbId: 987,
        requestId: 55, nowMs: 1200 }), { state: 'recorded', created: false });
      assert.deepEqual(ledger.recordInstallment({ tvdbId: 124, anidbId: 987,
        requestId: 56, nowMs: 1200 }),
      { state: 'held', reason: 'installment_parent_conflict' });
    } finally { ledger.close(); }
  }));

test('a claimed installment survives a failed submit and blocks another parent', async () =>
  withPath(async (dbPath) => {
    const first = openParentWatchLedger(dbPath);
    first.adopt({ tvdbId: 123, requesterId: 7, sourceSeriesId: 42, nowMs: 1000 });
    first.adopt({ tvdbId: 124, requesterId: 7, sourceSeriesId: 43, nowMs: 1000 });
    assert.deepEqual(first.claimInstallment({ tvdbId: 123, anidbId: 987,
      nowMs: 1100 }), { state: 'claimed', created: true });
    first.close();
    const second = openParentWatchLedger(dbPath);
    try {
      assert.deepEqual(second.claimInstallment({ tvdbId: 123, anidbId: 987,
        nowMs: 1200 }), { state: 'claimed', created: false });
      assert.deepEqual(second.claimInstallment({ tvdbId: 124, anidbId: 987,
        nowMs: 1200 }),
      { state: 'held', reason: 'installment_parent_conflict' });
      assert.deepEqual(second.listInstallments({ tvdbId: 123 }),
        [{ anidbId: 987, requestId: null }]);
      assert.deepEqual(second.recordInstallment({ tvdbId: 123, anidbId: 987,
        requestId: 55, nowMs: 1300 }), { state: 'recorded', created: true });
    } finally { second.close(); }
  }));

test('the reconciliation cursor advances durably and rejects stale writers', async () =>
  withPath(async (dbPath) => {
    const first = openParentWatchLedger(dbPath);
    assert.equal(first.getCursor(), 0);
    assert.deepEqual(first.advanceCursor({ expectedTvdbId: 0, nextTvdbId: 123 }),
      { state: 'advanced', tvdbId: 123 });
    assert.deepEqual(first.advanceCursor({ expectedTvdbId: 0, nextTvdbId: 124 }),
      { state: 'held', reason: 'stale_cursor' });
    first.close();
    const second = openParentWatchLedger(dbPath);
    try { assert.equal(second.getCursor(), 123); }
    finally { second.close(); }
  }));
