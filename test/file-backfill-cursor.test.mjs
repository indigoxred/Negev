import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openFileBackfillCursor, resetFileBackfillEvidence } from
  '../src/availability/file-backfill-cursor.mjs';
import { openFileProofLedger } from
  '../src/availability/file-proof-ledger.mjs';

test('new observer session withdraws old proofs and revisits the first hint', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-backfill-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const inventory = { listFileHintIds: ({ afterFileId, limit }) =>
    [2, 5, 9].filter((id) => id > afterFileId).slice(0, limit) };
  const cursor = openFileBackfillCursor(dbPath);
  const proofs = openFileProofLedger(dbPath, {
    positiveLifetimeMs: 10_000, now: () => 1_000 });
  try {
    const first = cursor.claim({ inventory, nowMs: 100, limit: 2 });
    assert.deepEqual(first.fileIds, [2, 5]);
    assert.equal(cursor.record({ claim: first,
      outcomes: [{ fileId: 2, state: 'available' },
        { fileId: 5, state: 'unknown' }], nowMs: 101 }).state, 'recorded');
    assert.equal(proofs.observe({ anidbId: 42, episodeId: 1001,
      proof: { fileId: 2, libraryId: 102, ratingKey: 500, partId: 900 },
      checkedMs: 900 }).state, 'recorded');
    const pending = cursor.claim({ inventory, nowMs: 102, limit: 2 });
    assert.deepEqual(pending.fileIds, [9]);
    resetFileBackfillEvidence(dbPath);
    assert.equal(proofs.getCurrent({ anidbId: 42, episodeId: 1001 }).state,
      'unknown');
    assert.equal(cursor.record({ claim: pending,
      outcomes: [{ fileId: 9, state: 'unknown' }], nowMs: 103 }).state,
      'held');
    const restarted = cursor.claim({ inventory, nowMs: 104, limit: 2 });
    assert.deepEqual(restarted.fileIds, [2]);
    assert.equal(restarted.priority, true);
    assert.equal(restarted.pass, first.pass + 1);
    assert.equal(cursor.record({ claim: restarted,
      outcomes: [{ fileId: 2, state: 'available' }], nowMs: 105 }).state,
    'recorded');
    assert.deepEqual(cursor.claim({ inventory, nowMs: 106, limit: 2 }).fileIds,
      [2, 5]);
  } finally {
    proofs.close(); cursor.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('restart rechecks formerly proven file IDs before the full inventory pass', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-priority-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const inventory = { listFileHintIds: ({ afterFileId, limit }) =>
    [2, 5, 9].filter((id) => id > afterFileId).slice(0, limit) };
  const cursor = openFileBackfillCursor(dbPath);
  const proofs = openFileProofLedger(dbPath, {
    positiveLifetimeMs: 10_000, now: () => 1_000 });
  try {
    assert.equal(proofs.observe({ anidbId: 42, episodeId: 1001,
      proof: { fileId: 9, libraryId: 102, ratingKey: 500, partId: 900 },
      checkedMs: 900 }).state, 'recorded');
    resetFileBackfillEvidence(dbPath);
    assert.equal(proofs.getCurrent({ anidbId: 42, episodeId: 1001 }).state,
      'unknown');
    const priority = cursor.claim({ inventory, nowMs: 1_001, limit: 1 });
    assert.deepEqual(priority.fileIds, [9]);
    assert.equal(priority.priority, true);
    resetFileBackfillEvidence(dbPath);
    const resumed = cursor.claim({ inventory, nowMs: 1_002, limit: 1 });
    assert.deepEqual(resumed.fileIds, [9]);
    assert.equal(resumed.priority, true);
    assert.equal(cursor.record({ claim: priority,
      outcomes: [{ fileId: 9, state: 'available' }], nowMs: 1_002 }).state,
    'held');
    assert.deepEqual(cursor.record({ claim: resumed,
      outcomes: [{ fileId: 9, state: 'unknown' }], nowMs: 1_003 }),
    { state: 'recorded', count: 1 });
    const ordinary = cursor.claim({ inventory, nowMs: 1_004, limit: 1 });
    assert.deepEqual(ordinary.fileIds, [2]);
    assert.equal(ordinary.priority, undefined);
  } finally {
    proofs.close(); cursor.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('file backfill retries a pending claim after restart and wraps after a complete pass', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-backfill-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const inventory = { listFileHintIds: ({ afterFileId, limit }) =>
    [2, 5, 9].filter((id) => id > afterFileId).slice(0, limit) };
  let cursor = openFileBackfillCursor(dbPath);
  try {
    const first = cursor.claim({ inventory, nowMs: 100, limit: 2 });
    assert.equal(first.state, 'claimed');
    assert.deepEqual(first.fileIds, [2, 5]);
    cursor.close();
    cursor = openFileBackfillCursor(dbPath);
    assert.deepEqual(cursor.claim({ inventory, nowMs: 200, limit: 2 }), first);
    assert.deepEqual(cursor.record({ claim: first,
      outcomes: [{ fileId: 2, state: 'unknown' },
        { fileId: 5, state: 'available' }], nowMs: 210 }),
    { state: 'recorded', count: 2 });
    const second = cursor.claim({ inventory, nowMs: 220, limit: 2 });
    assert.deepEqual(second.fileIds, [9]);
    assert.deepEqual(cursor.record({ claim: second,
      outcomes: [{ fileId: 9, state: 'held' }], nowMs: 230 }),
    { state: 'recorded', count: 1 });
    const wrapped = cursor.claim({ inventory, nowMs: 240, limit: 2 });
    assert.equal(wrapped.pass, first.pass + 1);
    assert.deepEqual(wrapped.fileIds, [2, 5]);
  } finally { cursor.close(); await rm(dir, { recursive: true, force: true }); }
});

test('stale or malformed receipts cannot advance the file cursor', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-backfill-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const inventory = { listFileHintIds: ({ afterFileId }) =>
    [7, 8].filter((id) => id > afterFileId) };
  const cursor = openFileBackfillCursor(dbPath);
  try {
    const claim = cursor.claim({ inventory, nowMs: 100, limit: 2 });
    assert.equal(cursor.record({ claim: { ...claim, receipt: claim.receipt + 1 },
      outcomes: [{ fileId: 7, state: 'unknown' },
        { fileId: 8, state: 'unknown' }], nowMs: 101 }).state, 'held');
    assert.equal(cursor.record({ claim, outcomes: [{ fileId: 8,
      state: 'available' }], nowMs: 102 }).state, 'held');
    assert.deepEqual(cursor.claim({ inventory, nowMs: 103, limit: 2 }), claim);
  } finally { cursor.close(); await rm(dir, { recursive: true, force: true }); }
});

test('an invalid inventory page holds without advancing or persisting a claim', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-backfill-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const cursor = openFileBackfillCursor(dbPath);
  try {
    const invalid = { listFileHintIds: () => [8, 7] };
    assert.deepEqual(cursor.claim({ inventory: invalid, nowMs: 100,
      limit: 2 }), { state: 'held', reason: 'invalid_file_hint_page' });
    const valid = { listFileHintIds: () => [7, 8] };
    const claim = cursor.claim({ inventory: valid, nowMs: 101, limit: 2 });
    assert.equal(claim.receipt, 1);
    assert.deepEqual(claim.fileIds, [7, 8]);
  } finally { cursor.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a large linked file resumes at its saved episode offset after restart', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-backfill-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const inventory = { listFileHintIds: ({ afterFileId }) =>
    [7, 8].filter((id) => id > afterFileId).slice(0, 1) };
  const fingerprint = 'a'.repeat(64);
  let cursor = openFileBackfillCursor(dbPath);
  try {
    const first = cursor.claim({ inventory, nowMs: 100, limit: 1 });
    assert.deepEqual(first.fileIds, [7]);
    assert.equal(first.pairOffset, 0);
    assert.equal(first.fingerprint, null);
    assert.deepEqual(cursor.record({ claim: first, outcomes: [{ fileId: 7,
      state: 'partial', nextPairOffset: 10, fingerprint }], nowMs: 200 }),
    { state: 'partial', count: 1 });
    cursor.close();
    cursor = openFileBackfillCursor(dbPath);
    const resumed = cursor.claim({ inventory, nowMs: 300, limit: 1 });
    assert.equal(resumed.pairOffset, 10);
    assert.equal(resumed.fingerprint, fingerprint);
    assert.equal(resumed.receipt, first.receipt + 1);
    assert.equal(cursor.record({ claim: first, outcomes: [{ fileId: 7,
      state: 'unknown' }], nowMs: 300 }).state, 'held');
    assert.deepEqual(cursor.record({ claim: resumed,
      outcomes: [{ fileId: 7, state: 'partial',
        nextPairOffset: 1, fingerprint: 'b'.repeat(64) }], nowMs: 301 }),
    { state: 'partial', count: 1 });
    const changed = cursor.claim({ inventory, nowMs: 302, limit: 1 });
    assert.equal(changed.pairOffset, 1);
    assert.equal(changed.fingerprint, 'b'.repeat(64));
    assert.deepEqual(cursor.record({ claim: changed,
      outcomes: [{ fileId: 7, state: 'available' }], nowMs: 301 }),
    { state: 'recorded', count: 1 });
    assert.deepEqual(cursor.claim({ inventory, nowMs: 302, limit: 1 }).fileIds,
      [8]);
  } finally { cursor.close(); await rm(dir, { recursive: true, force: true }); }
});
