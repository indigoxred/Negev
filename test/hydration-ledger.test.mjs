import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openHydrationLedger } from '../src/catalogue/hydration-ledger.mjs';

const nowMs = 1_000_000_000;
const pending = (anidbId, atMs = nowMs) =>
  ({ anidbId, titleKnown: true, detailState: 'detail_pending', nowMs: atMs });
const details = (anidbId) => ({ state: 'details', anidbId, complete: true, total: 1,
  episodes: [{ id: anidbId + 10_000, type: 'Episode' }] });

async function withDatabase(run) {
  const base = path.resolve(tmpdir());
  const dir = await mkdtemp(path.join(base, 'negev-hydration-'));
  try { await run(path.join(dir, 'ledger.sqlite')); }
  finally {
    assert.equal(path.dirname(path.resolve(dir)), base);
    await rm(dir, { recursive: true, force: true });
  }
}

test('reserves one title durably before any external refresh', async () => withDatabase(async (dbPath) => {
  const ledger = openHydrationLedger(dbPath);
  try {
    const claim = ledger.reserve(pending(1234));
    assert.equal(claim.state, 'reserved');
    assert.ok(Number.isSafeInteger(claim.claimId));
    assert.deepEqual(ledger.getClaim(claim.claimId), {
      id: claim.claimId, anidbId: 1234, claimedMs: nowMs,
      leaseUntilMs: nowMs + 600_000, status: 'reserved',
    });
  } finally { ledger.close(); }
}));

test('two database connections cannot reserve overlapping refreshes', async () => withDatabase(async (dbPath) => {
  const first = openHydrationLedger(dbPath);
  const second = openHydrationLedger(dbPath);
  try {
    assert.equal(first.reserve(pending(1234)).state, 'reserved');
    assert.deepEqual(second.reserve(pending(5678)), { state: 'defer', reason: 'active_refresh' });
  } finally { first.close(); second.close(); }
}));

test('restart and expired lease do not cause a same-title resubmission', async () => withDatabase(async (dbPath) => {
  const first = openHydrationLedger(dbPath);
  first.reserve(pending(1234));
  first.close();
  const restarted = openHydrationLedger(dbPath);
  try {
    assert.deepEqual(restarted.reserve(pending(1234, nowMs + 600_001)), {
      state: 'defer', reason: 'title_cooldown', retryAtMs: nowMs + 86_400_000,
    });
  } finally { restarted.close(); }
}));

test('an uncertain title cannot block later titles after its lease expires', async () => withDatabase(async (dbPath) => {
  const ledger = openHydrationLedger(dbPath);
  try {
    ledger.reserve(pending(1234));
    assert.deepEqual(ledger.reserve(pending(5678, nowMs + 60_000)),
      { state: 'defer', reason: 'active_refresh' });
    assert.equal(ledger.reserve(pending(5678, nowMs + 600_001)).state, 'reserved');
  } finally { ledger.close(); }
}));

test('only exact completed detail closes a reservation', async () => withDatabase(async (dbPath) => {
  const ledger = openHydrationLedger(dbPath);
  try {
    const claim = ledger.reserve(pending(1234));
    assert.deepEqual(ledger.finishFromDetail(claim.claimId, details(9999), nowMs + 1),
      { state: 'held', reason: 'invalid_detail_evidence' });
    assert.deepEqual(ledger.finishFromDetail(claim.claimId, {
      ...details(1234), episodes: [{ id: 9, type: 'Trailer' }],
    }, nowMs + 1), { state: 'held', reason: 'invalid_detail_evidence' });
    assert.deepEqual(ledger.finishFromDetail(claim.claimId, details(1234), nowMs + 1),
      { state: 'completed' });
    assert.equal(ledger.getClaim(claim.claimId).status, 'completed');
    assert.equal(ledger.reserve(pending(5678, nowMs + 60_000)).state, 'reserved');
  } finally { ledger.close(); }
}));

test('a later detail read closes the latest matching reservation by title', async () => withDatabase(async (dbPath) => {
  const ledger = openHydrationLedger(dbPath);
  try {
    const claim = ledger.reserve(pending(1234));
    assert.deepEqual(ledger.finishLatestFromDetail(1234, details(9999), nowMs + 1),
      { state: 'held', reason: 'invalid_detail_evidence' });
    assert.equal(ledger.getClaim(claim.claimId).status, 'reserved');
    assert.deepEqual(ledger.finishLatestFromDetail(1234, details(1234), nowMs + 2),
      { state: 'completed' });
    assert.equal(ledger.getClaim(claim.claimId).status, 'completed');
    assert.deepEqual(ledger.finishLatestFromDetail(5678, details(5678), nowMs + 3),
      { state: 'no_claim' });
  } finally { ledger.close(); }
}));

test('rolling daily submission budget survives completion', async () => withDatabase(async (dbPath) => {
  const ledger = openHydrationLedger(dbPath);
  try {
    for (let index = 0; index < 30; index++) {
      const id = 1_000 + index;
      const at = nowMs + index * 60_000;
      const claim = ledger.reserve(pending(id, at));
      assert.equal(claim.state, 'reserved');
      assert.equal(ledger.finishFromDetail(claim.claimId, details(id), at + 1).state, 'completed');
    }
    assert.deepEqual(ledger.reserve(pending(9999, nowMs + 30 * 60_000)),
      { state: 'defer', reason: 'daily_budget' });
  } finally { ledger.close(); }
}));
