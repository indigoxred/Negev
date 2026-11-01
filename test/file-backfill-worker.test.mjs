import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openFileBackfillCursor } from
  '../src/availability/file-backfill-cursor.mjs';
import { createFileBackfillWorker } from
  '../src/availability/file-backfill-worker.mjs';
import { openFileProofLedger } from
  '../src/availability/file-proof-ledger.mjs';
import { openShokoInventoryLedger } from
  '../src/availability/shoko-inventory-worker.mjs';
import { openPlexCardIndex } from
  '../src/availability/plex-card-index.mjs';

const candidate = (count = 12, updated = '2026-11-02T00:00:00Z') => ({
  state: 'candidate', fileId: 7, updated, size: 5,
  releaseEvidence: 'registered', anidbFileId: 900,
  pairs: Array.from({ length: count }, (_, index) => ({
    anidbId: 42, episodeId: 1001 + index })),
  identities: Array.from({ length: count }, (_, index) => ({
    anidbId: 42, episodeId: 1001 + index, shokoSeriesId: 99,
    shokoEpisodeId: 2001 + index, tmdbMovieIds: [] })),
  sourcePaths: ['/pure/Anime/pack.mkv'] });

test('a 12-episode file advances in two bounded ticks and saves guarded positives', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-worker-'));
  const cursor = openFileBackfillCursor(path.join(dir, 'state.sqlite'));
  const seen = [];
  const saved = [];
  const inventory = {
    listFileHintIds: ({ afterFileId }) => [7, 8].filter(
      (id) => id > afterFileId).slice(0, 1),
    getFile: () => ({ state: 'linked', updated: candidate().updated,
      observedMs: 100 }),
  };
  const worker = createFileBackfillWorker({ cursor, inventory,
    readCandidate: async ({ fileId }) => fileId === 7
      ? candidate() : { state: 'unavailable' },
    resolveKind: async () => 'series',
    observeCandidate: async ({ target, budget }) => {
      seen.push(target.episodeId);
      budget.cardReads++;
      return { state: 'available', fileId: 7,
        proof: { fileId: 7, libraryId: 102, ratingKey: 500,
          partId: 600, storageKey: '1:2:5' },
        cardRevision: { observedMs: 100,
          identitySignature: 'synthetic-card' } };
    },
    proofs: { observeGuarded: (entry) => {
      saved.push(entry);
      return { state: 'recorded' };
    } }, now: () => 300, maxPairChecks: 10 });
  try {
    assert.deepEqual(await worker.runOnce(), { state: 'partial',
      checkedPairs: 10, available: 10, load: {
        cardReads: 10, physicalProbes: 0 } });
    assert.deepEqual(seen, Array.from({ length: 10 },
      (_, index) => 1001 + index));
    assert.equal(saved.length, 10);
    assert.deepEqual(saved[0].revision.source, { updated: candidate().updated,
      observedMs: 100 });
    assert.deepEqual(await worker.runOnce(), { state: 'checked',
      checkedPairs: 2, available: 2, load: {
        cardReads: 2, physicalProbes: 0 } });
    assert.deepEqual(seen.slice(10), [1011, 1012]);
    assert.equal(saved.length, 12);
    assert.deepEqual(await worker.runOnce(), { state: 'checked',
      checkedPairs: 0, available: 0, load: {
        cardReads: 0, physicalProbes: 0 } });
  } finally { cursor.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a changed Shoko candidate cannot save the already observed positive', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-worker-'));
  const cursor = openFileBackfillCursor(path.join(dir, 'state.sqlite'));
  let reads = 0;
  let writes = 0;
  const worker = createFileBackfillWorker({ cursor,
    inventory: { listFileHintIds: ({ afterFileId }) =>
      [7, 8].filter((id) => id > afterFileId).slice(0, 1),
    getFile: () => ({ state: 'linked', updated: candidate().updated,
      observedMs: 100 }) },
    readCandidate: async () => (++reads === 1 ? candidate(1) :
      candidate(1, '2026-11-02T01:00:00Z')),
    resolveKind: async () => 'series',
    observeCandidate: async () => ({ state: 'available', fileId: 7,
      proof: { fileId: 7, libraryId: 102, ratingKey: 500,
        partId: 600, storageKey: '1:2:5' },
      cardRevision: { observedMs: 100, identitySignature: 'synthetic' } }),
    proofs: { observeGuarded: () => { writes++; return { state: 'recorded' }; } },
    now: () => 300, maxPairChecks: 10 });
  try {
    assert.deepEqual(await worker.runOnce(), { state: 'checked',
      checkedPairs: 1, available: 0, load: {
        cardReads: 0, physicalProbes: 0 } });
    assert.equal(writes, 0);
    assert.deepEqual(cursor.claim({ inventory: { listFileHintIds: () => [8] },
      nowMs: 301, limit: 1 }).fileIds, [8]);
  } finally { cursor.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a shared card-read limit resumes the next episode instead of skipping it', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-worker-'));
  const cursor = openFileBackfillCursor(path.join(dir, 'state.sqlite'));
  const seen = [];
  const worker = createFileBackfillWorker({ cursor,
    inventory: { listFileHintIds: ({ afterFileId }) =>
      [7].filter((id) => id > afterFileId),
    getFile: () => ({ state: 'linked', updated: candidate().updated,
      observedMs: 100 }) },
    readCandidate: async () => candidate(2),
    resolveKind: async () => 'series',
    observeCandidate: async ({ target, budget }) => {
      seen.push(target.episodeId);
      budget.cardReads += target.episodeId === 1001 ? 10 : 1;
      return { state: 'available', fileId: 7,
        proof: { fileId: 7, libraryId: 102, ratingKey: 500,
          partId: 600, storageKey: '1:2:5' },
        cardRevision: { observedMs: 100,
          identitySignature: 'synthetic' } };
    },
    proofs: { observeGuarded: () => ({ state: 'recorded' }) },
    now: () => 300 });
  try {
    assert.equal((await worker.runOnce()).state, 'partial');
    assert.deepEqual(seen, [1001]);
    assert.equal((await worker.runOnce()).state, 'checked');
    assert.deepEqual(seen, [1001, 1002]);
  } finally { cursor.close(); await rm(dir, { recursive: true, force: true }); }
});

test('the worker saves one real SQLite proof only while both source generations stay current', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-worker-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const cursor = openFileBackfillCursor(dbPath);
  const inventory = openShokoInventoryLedger(dbPath);
  const plex = openPlexCardIndex(dbPath);
  const proofs = openFileProofLedger(dbPath, { positiveLifetimeMs: 1_000,
    now: () => 500 });
  try {
    inventory.recordFileObservation({ item: { fileId: 7,
      updated: candidate().updated, state: 'linked',
      pairs: [{ anidbId: 42, episodeId: 1001 }],
      hint: { size: 5, sourcePaths: ['/pure/Anime/pack.mkv'] } },
    observedMs: 100 });
    plex.recordCard({ libraryId: 102, ratingKey: 500,
      kind: 'episode', observedMs: 100, parts: [{ libraryId: 102,
        partId: 600, size: 5, plexPath: '/source-pure/pack.mkv',
        candidateKey: '1:2:5' }] });
    const worker = createFileBackfillWorker({ cursor, inventory,
      readCandidate: async () => candidate(1),
      resolveKind: async () => 'series',
      observeCandidate: async () => ({ state: 'available', fileId: 7,
        proof: { fileId: 7, libraryId: 102, ratingKey: 500,
          partId: 600, storageKey: '1:2:5' },
        cardRevision: plex.getCardRevision({ libraryId: 102,
          ratingKey: 500 }) }),
      proofs, now: () => 300 });
    assert.equal((await worker.runOnce()).available, 1);
    assert.deepEqual(proofs.getCurrent({ anidbId: 42, episodeId: 1001 }),
      { state: 'available', verifiedAtMs: 300 });
  } finally {
    proofs.close(); plex.close(); inventory.close(); cursor.close();
    await rm(dir, { recursive: true, force: true });
  }
});
