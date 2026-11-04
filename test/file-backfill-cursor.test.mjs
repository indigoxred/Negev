import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openFileBackfillCursor, resetFileBackfillEvidence } from
  '../src/availability/file-backfill-cursor.mjs';
import { openFileProofLedger } from
  '../src/availability/file-proof-ledger.mjs';

test('explicit recovery rewind keeps recent proofs and revisits the first hint', async () => {
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
      'available');
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

test('explicit recovery rechecks formerly proven file IDs first', async () => {
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
      'available');
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

test('a newly linked file can be queued once ahead of the historical pass', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-new-priority-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const inventory = { listFileHintIds: ({ afterFileId, limit }) =>
    [2, 5, 51].filter((id) => id > afterFileId).slice(0, limit) };
  let cursor = openFileBackfillCursor(dbPath);
  try {
    const ordinary = cursor.claim({ inventory, nowMs: 100, limit: 1 });
    assert.deepEqual(ordinary.fileIds, [2]);
    assert.equal(cursor.record({ claim: ordinary,
      outcomes: [{ fileId: 2, state: 'unknown' }], nowMs: 101 }).state,
    'recorded');
    assert.deepEqual(cursor.prioritizeFile({ fileId: 51, observedMs: 100 }),
      { state: 'queued' });
    assert.deepEqual(cursor.prioritizeFile({ fileId: 51, observedMs: 100 }),
      { state: 'unchanged' });
    cursor.close();
    cursor = openFileBackfillCursor(dbPath);
    const recent = cursor.claim({ inventory, nowMs: 102, limit: 1 });
    assert.deepEqual(recent.fileIds, [51]);
    assert.equal(recent.priority, true);
    assert.equal(cursor.record({ claim: recent,
      outcomes: [{ fileId: 51, state: 'unknown' }], nowMs: 103 }).state,
    'recorded');
    const resumedOrdinary = cursor.claim({ inventory, nowMs: 104, limit: 1 });
    assert.deepEqual(resumedOrdinary.fileIds, [5]);
    assert.equal(cursor.record({ claim: resumedOrdinary,
      outcomes: [{ fileId: 5, state: 'unknown' }], nowMs: 104 }).state,
    'recorded');
    assert.deepEqual(cursor.confirmRecentFile({ fileId: 51, nowMs: 105 }),
      { state: 'queued' });
    const afterCard = cursor.claim({ inventory, nowMs: 106, limit: 1 });
    assert.deepEqual(afterCard.fileIds, [51]);
    assert.equal(afterCard.priority, true);
    assert.equal(cursor.record({ claim: afterCard,
      outcomes: [{ fileId: 51, state: 'available' }], nowMs: 107 }).state,
    'recorded');
    assert.deepEqual(cursor.confirmRecentFile({ fileId: 51, nowMs: 108 }),
      { state: 'unchanged' });
  } finally {
    cursor.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('an old event cannot keep reordering the historical pass', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-priority-expiry-'));
  const cursor = openFileBackfillCursor(path.join(dir, 'state.sqlite'));
  try {
    cursor.prioritizeFile({ fileId: 51, observedMs: 100 });
    const inventory = { listFileHintIds: () => [] };
    const claim = cursor.claim({ inventory, nowMs: 101 });
    cursor.record({ claim, outcomes: [{ fileId: 51, state: 'unknown' }],
      nowMs: 102 });
    assert.deepEqual(cursor.confirmRecentFile({ fileId: 51,
      nowMs: 100 + 30 * 60_000 + 1 }), { state: 'unchanged' });
    assert.equal(cursor.claim({ inventory,
      nowMs: 100 + 30 * 60_000 + 2 }).state, 'idle');
  } finally {
    cursor.close(); await rm(dir, { recursive: true, force: true });
  }
});

test('a new file outranks recovery rechecks without increasing claim size', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-priority-rank-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const cursor = openFileBackfillCursor(dbPath);
  const proofs = openFileProofLedger(dbPath, {
    positiveLifetimeMs: 10_000, now: () => 100 });
  try {
    proofs.observe({ anidbId: 42, episodeId: 1001,
      proof: { fileId: 5, libraryId: 102, ratingKey: 500, partId: 900 },
      checkedMs: 99 });
    resetFileBackfillEvidence(dbPath);
    cursor.prioritizeFile({ fileId: 51, observedMs: 100 });
    const claim = cursor.claim({ inventory: { listFileHintIds: () => [] },
      nowMs: 101, limit: 1 });
    assert.deepEqual(claim.fileIds, [51]);
    assert.equal(claim.priority, true);
  } finally {
    proofs.close(); cursor.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a bounded mixed-rank priority page survives replay and records in rank order', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-priority-page-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const cursor = openFileBackfillCursor(dbPath);
  const proofs = openFileProofLedger(dbPath, {
    positiveLifetimeMs: 10_000, now: () => 100 });
  try {
    proofs.observe({ anidbId: 42, episodeId: 1001,
      proof: { fileId: 5, libraryId: 102, ratingKey: 500, partId: 900 },
      checkedMs: 99 });
    resetFileBackfillEvidence(dbPath);
    cursor.prioritizeFile({ fileId: 51, observedMs: 100 });
    const inventory = { listFileHintIds: () => [] };
    const claim = cursor.claim({ inventory, nowMs: 101, limit: 2 });
    assert.equal(claim.state, 'claimed');
    assert.equal(claim.priority, true);
    assert.deepEqual(claim.fileIds, [51, 5]);
    assert.deepEqual(cursor.claim({ inventory, nowMs: 102, limit: 2 }).fileIds,
      [51, 5]);
    assert.equal(cursor.record({ claim, outcomes: [
      { fileId: 51, state: 'available' },
      { fileId: 5, state: 'unknown' },
    ], nowMs: 103 }).state, 'recorded');
    assert.equal(cursor.claim({ inventory, nowMs: 104, limit: 2 }).state, 'idle');
  } finally {
    proofs.close(); cursor.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a positive during an in-flight early miss queues one later recheck', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-priority-race-'));
  const cursor = openFileBackfillCursor(path.join(dir, 'state.sqlite'));
  try {
    cursor.prioritizeFile({ fileId: 51, observedMs: 100 });
    const inventory = { listFileHintIds: () => [] };
    const early = cursor.claim({ inventory, nowMs: 101, limit: 1 });
    assert.deepEqual(cursor.confirmRecentFile({ fileId: 51, nowMs: 102 }),
      { state: 'queued' });
    assert.equal(cursor.record({ claim: early,
      outcomes: [{ fileId: 51, state: 'unknown' }], nowMs: 103 }).state,
    'recorded');
    const retry = cursor.claim({ inventory, nowMs: 104, limit: 1 });
    assert.deepEqual(retry.fileIds, [51]);
    assert.equal(cursor.record({ claim: retry,
      outcomes: [{ fileId: 51, state: 'available' }], nowMs: 105 }).state,
    'recorded');
    assert.equal(cursor.claim({ inventory, nowMs: 106 }).state, 'idle');
  } finally { cursor.close(); await rm(dir, { recursive: true, force: true }); }
});

test('v0.0.34 cursor schema migrates before queuing old proofs', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-migrate-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const old = new DatabaseSync(dbPath);
  old.exec(`CREATE TABLE file_backfill_cursor (
    id INTEGER PRIMARY KEY, after_file_id INTEGER NOT NULL,
    pass INTEGER NOT NULL, receipt INTEGER NOT NULL,
    pending_json TEXT, claimed_ms INTEGER,
    pair_offset INTEGER NOT NULL DEFAULT 0, fingerprint TEXT) STRICT;
    INSERT INTO file_backfill_cursor (id,after_file_id,pass,receipt)
      VALUES (1,500,3,7);
    CREATE TABLE file_availability_proofs (
      anidb_id INTEGER NOT NULL, episode_id INTEGER NOT NULL,
      file_id INTEGER NOT NULL, library_id INTEGER NOT NULL,
      rating_key INTEGER NOT NULL, part_id INTEGER NOT NULL,
      verified_ms INTEGER NOT NULL,
      PRIMARY KEY(anidb_id,episode_id,file_id,library_id,rating_key,part_id)
    ) STRICT;
    INSERT INTO file_availability_proofs VALUES (42,1001,450,102,500,900,900);`);
  old.close();
  const cursor = openFileBackfillCursor(dbPath);
  try {
    resetFileBackfillEvidence(dbPath);
    const inventory = { listFileHintIds: () => [2] };
    const claim = cursor.claim({ inventory, nowMs: 1_000, limit: 1 });
    assert.deepEqual(claim.fileIds, [450]);
    assert.equal(claim.priority, true);
    assert.equal(claim.pass, 4);
  } finally {
    cursor.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('partial priority claim resumes with its file and pair offset', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-partial-priority-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const proofs = openFileProofLedger(dbPath, {
    positiveLifetimeMs: 10_000, now: () => 1_000 });
  let cursor = openFileBackfillCursor(dbPath);
  const inventory = { listFileHintIds: ({ afterFileId, limit }) =>
    [2, 9].filter((id) => id > afterFileId).slice(0, limit) };
  try {
    proofs.observe({ anidbId: 42, episodeId: 1001,
      proof: { fileId: 9, libraryId: 102, ratingKey: 500, partId: 900 },
      checkedMs: 900 });
    resetFileBackfillEvidence(dbPath);
    const first = cursor.claim({ inventory, nowMs: 1_001, limit: 1 });
    const fingerprint = 'a'.repeat(64);
    assert.equal(cursor.record({ claim: first, outcomes: [{ fileId: 9,
      state: 'partial', nextPairOffset: 3, fingerprint }], nowMs: 1_002 }).state,
    'partial');
    cursor.close();
    cursor = openFileBackfillCursor(dbPath);
    const resumed = cursor.claim({ inventory, nowMs: 1_003, limit: 1 });
    assert.deepEqual(resumed.fileIds, [9]);
    assert.equal(resumed.priority, true);
    assert.equal(resumed.pairOffset, 3);
    assert.equal(resumed.fingerprint, fingerprint);
    assert.equal(cursor.record({ claim: resumed, outcomes: [{ fileId: 9,
      state: 'unknown' }], nowMs: 1_004 }).state, 'recorded');
    assert.deepEqual(cursor.claim({ inventory, nowMs: 1_005, limit: 1 }).fileIds,
      [2]);
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
