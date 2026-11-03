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

test('a flagged existing release can earn a proof while later files advance', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-flagged-'));
  const cursor = openFileBackfillCursor(path.join(dir, 'state.sqlite'));
  const checked = [];
  let proofWrites = 0;
  const worker = createFileBackfillWorker({ cursor, maxFilesPerTick: 2,
    inventory: { listFileHintIds: ({ afterFileId }) =>
      [7, 8].filter((id) => id > afterFileId).slice(0, 1),
    getFile: () => ({ state: 'linked', updated: candidate(1).updated,
      observedMs: 100 }) },
    readCandidate: async ({ fileId }) => ({ ...candidate(1), fileId,
      releaseEvidence: fileId === 7 ? 'anidb_flagged' : 'registered' }),
    resolveKind: async () => 'series',
    observeCandidate: async ({ candidate: file }) => {
      checked.push(file.fileId);
      return file.fileId === 7 ? { state: 'available', fileId: 7,
        proof: { fileId: 7 }, cardRevision: { observedMs: 200 } }
        : { state: 'unknown' };
    },
    proofs: { observeGuarded: () => { proofWrites++; return { state: 'recorded' }; } },
    now: () => 300 });
  try {
    assert.deepEqual(await worker.runOnce(), { state: 'checked',
      checkedFiles: 2, checkedPairs: 2, available: 1,
      load: { cardReads: 0, physicalProbes: 0 } });
    assert.deepEqual(checked, [7, 8]);
    assert.equal(proofWrites, 1);
  } finally { cursor.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a rejected source-generation proof keeps its file due for a fresh check', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-proof-race-'));
  const cursor = openFileBackfillCursor(path.join(dir, 'state.sqlite'));
  let proofWrites = 0;
  let cardReads = 0;
  const worker = createFileBackfillWorker({ cursor,
    inventory: { listFileHintIds: ({ afterFileId }) =>
      [7, 8].filter((id) => id > afterFileId).slice(0, 1),
    getFile: () => ({ state: 'linked', updated: candidate(1).updated,
      observedMs: 100 }) },
    readCandidate: async ({ fileId }) => ({ ...candidate(1), fileId }),
    resolveKind: async () => 'series',
    observeCandidate: async ({ candidate: file }) => {
      cardReads++;
      return { state: 'available', fileId: file.fileId,
        proof: { fileId: file.fileId }, cardRevision: { observedMs: 200 } };
    },
    proofs: { observeGuarded: () => ++proofWrites === 1
      ? { state: 'held', reason: 'source_generation_changed' }
      : { state: 'recorded' } },
    now: () => 300 });
  try {
    assert.deepEqual(await worker.runOnce(), { state: 'held',
      reason: 'source_read_unavailable' });
    assert.deepEqual(await worker.runOnce(), { state: 'checked',
      checkedPairs: 1, available: 1,
      load: { cardReads: 0, physicalProbes: 0 } });
    assert.equal(cardReads, 2);
    assert.equal((await worker.runOnce()).state, 'checked');
  } finally { cursor.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a stale guarded proof is not counted as available', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-stale-'));
  const cursor = openFileBackfillCursor(path.join(dir, 'state.sqlite'));
  const worker = createFileBackfillWorker({ cursor,
    inventory: { listFileHintIds: ({ afterFileId }) =>
      [7].filter((id) => id > afterFileId),
    getFile: () => ({ state: 'linked', updated: candidate(1).updated,
      observedMs: 100 }) },
    readCandidate: async () => candidate(1),
    resolveKind: async () => 'series',
    observeCandidate: async () => ({ state: 'available', fileId: 7,
      proof: { fileId: 7, libraryId: 102, ratingKey: 500,
        partId: 600, storageKey: '1:2:5' },
      cardRevision: { observedMs: 200, identitySignature: 'stale-card' } }),
    proofs: { observeGuarded: () => ({ state: 'stale' }) },
    now: () => 300 });
  try {
    assert.deepEqual(await worker.runOnce(), { state: 'checked',
      checkedPairs: 1, available: 0,
      load: { cardReads: 0, physicalProbes: 0 } });
  } finally { cursor.close(); await rm(dir, { recursive: true, force: true }); }
});

for (const busyAt of ['first_file', 'kind', 'card', 'final_file']) {
  test(`metadata contention at ${busyAt} retries the same file`, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-busy-'));
    const cursor = openFileBackfillCursor(path.join(dir, 'state.sqlite'));
    let fileReads = 0;
    let kinds = 0;
    let cards = 0;
    const worker = createFileBackfillWorker({ cursor,
      inventory: { listFileHintIds: ({ afterFileId }) =>
        [7, 8].filter((id) => id > afterFileId).slice(0, 1),
      getFile: () => ({ state: 'linked', updated: candidate(1).updated,
        observedMs: 100 }) },
      readCandidate: async () => {
        fileReads++;
        return busyAt === 'first_file' && fileReads === 1 ||
          busyAt === 'final_file' && fileReads === 2
          ? { state: 'busy' } : candidate(1);
      },
      resolveKind: async () => {
        kinds++;
        return busyAt === 'kind' && kinds === 1 ? { state: 'busy' } : 'series';
      },
      observeCandidate: async () => {
        cards++;
        return busyAt === 'card' && cards === 1
          ? { state: 'busy' } : { state: 'unknown' };
      },
      proofs: { observeGuarded: () => { throw Error('No positive'); } },
      now: () => 300 });
    try {
      assert.deepEqual(await worker.runOnce(), {
        state: 'held', reason: 'metadata_busy' });
      assert.equal((await worker.runOnce()).state, 'checked');
      assert.equal((await worker.runOnce()).state, 'checked');
    } finally { cursor.close(); await rm(dir, { recursive: true, force: true }); }
  });
}

for (const busyAt of ['first_file', 'kind', 'card', 'final_file']) {
  test(`persistent ${busyAt} contention defers one file and reaches the next`, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-busy-age-'));
    const cursor = openFileBackfillCursor(path.join(dir, 'state.sqlite'));
    let clock = 300;
    let activeFile = 0;
    let fileReads = 0;
    let proofWrites = 0;
    const worker = createFileBackfillWorker({ cursor,
      inventory: { listFileHintIds: ({ afterFileId }) =>
        [7, 8].filter((id) => id > afterFileId).slice(0, 1),
      getFile: () => ({ state: 'linked', updated: candidate(1).updated,
        observedMs: 100 }) },
      readCandidate: async ({ fileId }) => {
        activeFile = fileId;
        fileReads++;
        return fileId === 7 && (busyAt === 'first_file' ||
          busyAt === 'final_file' && fileReads % 2 === 0)
          ? { state: 'busy' } : { ...candidate(1), fileId };
      },
      resolveKind: async () => activeFile === 7 && busyAt === 'kind'
        ? { state: 'busy' } : 'series',
      observeCandidate: async () => activeFile === 7 && busyAt === 'card'
        ? { state: 'busy' } : { state: 'unknown' },
      proofs: { observeGuarded: () => { proofWrites++; return { state: 'recorded' }; } },
      now: () => clock });
    try {
      assert.deepEqual(await worker.runOnce(), {
        state: 'held', reason: 'metadata_busy' });
      clock += 15 * 60_000 - 1;
      assert.deepEqual(await worker.runOnce(), {
        state: 'held', reason: 'metadata_busy' });
      clock++;
      assert.deepEqual(await worker.runOnce(), {
        state: 'checked', reason: 'metadata_busy_deferred',
        checkedPairs: 0, available: 0,
        load: { cardReads: 0, physicalProbes: 0 } });
      assert.equal((await worker.runOnce()).state, 'checked');
      assert.equal(activeFile, 8);
      assert.equal(proofWrites, 0);
    } finally { cursor.close(); await rm(dir, { recursive: true, force: true }); }
  });
}

test('a multi-file tick reports expired contention as deferred work', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-busy-batch-'));
  const cursor = openFileBackfillCursor(path.join(dir, 'state.sqlite'));
  let clock = 300;
  const worker = createFileBackfillWorker({ cursor, maxFilesPerTick: 2,
    inventory: { listFileHintIds: ({ afterFileId }) =>
      [7, 8].filter((id) => id > afterFileId).slice(0, 1),
    getFile: () => ({ state: 'linked', updated: candidate(1).updated,
      observedMs: 100 }) },
    readCandidate: async ({ fileId }) => fileId === 7
      ? { state: 'busy' } : { ...candidate(1), fileId },
    resolveKind: async () => 'series',
    observeCandidate: async () => ({ state: 'unknown' }),
    proofs: { observeGuarded: () => { throw Error('No positive'); } },
    now: () => clock });
  try {
    assert.deepEqual(await worker.runOnce(), {
      state: 'held', reason: 'metadata_busy' });
    clock += 15 * 60_000;
    assert.deepEqual(await worker.runOnce(), {
      state: 'checked', checkedFiles: 1, deferredFiles: 1,
      checkedPairs: 1, available: 0,
      load: { cardReads: 0, physicalProbes: 0 } });
  } finally { cursor.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a busy partial file survives restart and is revisited on the next pass', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-busy-partial-'));
  const dbPath = path.join(dir, 'state.sqlite');
  let cursor = openFileBackfillCursor(dbPath);
  let clock = 300;
  let ledger = openFileProofLedger(dbPath, {
    positiveLifetimeMs: 7 * 24 * 60 * 60_000, now: () => clock });
  let holdRemainingPair = true;
  const checked = [];
  const savedProofs = [];
  const makeWorker = () => createFileBackfillWorker({ cursor,
    inventory: { listFileHintIds: ({ afterFileId }) =>
      [7, 8].filter((id) => id > afterFileId).slice(0, 1),
    getFile: () => ({ state: 'linked', updated: candidate(12).updated,
      observedMs: 100 }) },
    readCandidate: async ({ fileId }) => ({
      ...candidate(fileId === 7 ? 12 : 1), fileId }),
    resolveKind: async () => 'series',
    observeCandidate: async ({ candidate: file, target }) => {
      checked.push([file.fileId, target.episodeId]);
      if (file.fileId === 7 && target.episodeId === 1011 &&
          holdRemainingPair) return { state: 'busy' };
      return file.fileId === 7 && target.episodeId === 1001
        ? { state: 'available', fileId: 7,
          proof: { fileId: 7, libraryId: 102, ratingKey: 500,
            partId: 600 },
          cardRevision: { observedMs: 100 } }
        : { state: 'unknown' };
    },
    proofs: { observeGuarded: ({ anidbId, episodeId, proof,
      checkedMs }) => {
      savedProofs.push(episodeId);
      return ledger.observe({ anidbId, episodeId, proof, checkedMs });
    } },
    now: () => clock });
  try {
    assert.equal((await makeWorker().runOnce()).state, 'partial');
    assert.deepEqual(savedProofs, [1001]);
    assert.equal(ledger.getCurrent({ anidbId: 42, episodeId: 1001 }).state,
      'available');
    cursor.close();
    ledger.close();
    cursor = openFileBackfillCursor(dbPath);
    ledger = openFileProofLedger(dbPath, {
      positiveLifetimeMs: 7 * 24 * 60 * 60_000, now: () => clock });
    const restarted = makeWorker();
    assert.deepEqual(await restarted.runOnce(), {
      state: 'held', reason: 'metadata_busy' });
    clock += 15 * 60_000;
    assert.equal((await restarted.runOnce()).reason, 'metadata_busy_deferred');
    assert.deepEqual(savedProofs, [1001]);
    assert.equal(ledger.getCurrent({ anidbId: 42, episodeId: 1001 }).state,
      'available');
    assert.equal((await restarted.runOnce()).state, 'checked');
    assert.deepEqual(checked.at(-1), [8, 1001]);
    holdRemainingPair = false;
    assert.equal((await restarted.runOnce()).state, 'partial');
    assert.deepEqual(savedProofs, [1001, 1001]);
    assert.equal((await restarted.runOnce()).state, 'checked');
    assert.deepEqual(checked.slice(-2), [[7, 1011], [7, 1012]]);
  } finally {
    ledger.close(); cursor.close();
    await rm(dir, { recursive: true, force: true });
  }
});

for (const failAt of ['first_file', 'kind', 'card', 'final_file']) {
  test(`a thrown ${failAt} read retries once, then advances past the failed file`, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-error-'));
    const cursor = openFileBackfillCursor(path.join(dir, 'state.sqlite'));
    let reads = 0;
    let activeFile = 0;
    const worker = createFileBackfillWorker({ cursor,
      inventory: { listFileHintIds: ({ afterFileId }) =>
        [7, 8].filter((id) => id > afterFileId).slice(0, 1),
      getFile: () => ({ state: 'linked', updated: candidate(1).updated,
        observedMs: 100 }) },
      readCandidate: async ({ fileId }) => {
        activeFile = fileId;
        reads++;
        if (fileId === 7 && (failAt === 'first_file' ||
            (failAt === 'final_file' && reads % 2 === 0))) {
          throw Error('Synthetic source failure');
        }
        return { ...candidate(1), fileId };
      },
      resolveKind: async () => {
        if (activeFile === 7 && failAt === 'kind') {
          throw Error('Synthetic source failure');
        }
        return 'series';
      },
      observeCandidate: async () => {
        if (activeFile === 7 && failAt === 'card') {
          throw Error('Synthetic source failure');
        }
        return { state: 'unknown' };
      },
      proofs: { observeGuarded: () => { throw Error('No positive'); } },
      now: () => 300 });
    try {
      assert.deepEqual(await worker.runOnce(), {
        state: 'held', reason: 'source_read_unavailable' });
      assert.equal((await worker.runOnce()).state, 'checked');
      assert.equal((await worker.runOnce()).state, 'checked');
    } finally { cursor.close(); await rm(dir, { recursive: true, force: true }); }
  });
}

for (const unavailableAt of ['first_file', 'kind', 'card', 'final_file']) {
  test(`a returned ${unavailableAt} outage retries once without blocking later files`, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-outage-'));
    const cursor = openFileBackfillCursor(path.join(dir, 'state.sqlite'));
    let reads = 0;
    let activeFile = 0;
    const worker = createFileBackfillWorker({ cursor,
      inventory: { listFileHintIds: ({ afterFileId }) =>
        [7, 8].filter((id) => id > afterFileId).slice(0, 1),
      getFile: () => ({ state: 'linked', updated: candidate(1).updated,
        observedMs: 100 }) },
      readCandidate: async ({ fileId }) => {
        activeFile = fileId;
        reads++;
        if (fileId === 7 && (unavailableAt === 'first_file' ||
            (unavailableAt === 'final_file' && reads % 2 === 0))) {
          return { state: 'unavailable' };
        }
        return { ...candidate(1), fileId };
      },
      resolveKind: async () => activeFile === 7 && unavailableAt === 'kind'
        ? { state: 'unavailable' } : 'series',
      observeCandidate: async () => activeFile === 7 && unavailableAt === 'card'
        ? { state: 'unknown', reason: 'observer_incomplete' }
        : { state: 'unknown' },
      proofs: { observeGuarded: () => { throw Error('No positive'); } },
      now: () => 300 });
    try {
      assert.deepEqual(await worker.runOnce(), {
        state: 'held', reason: 'source_read_unavailable' });
      assert.equal((await worker.runOnce()).state, 'checked');
      assert.equal((await worker.runOnce()).state, 'checked');
    } finally { cursor.close(); await rm(dir, { recursive: true, force: true }); }
  });
}

test('a failed saved claim eventually advances after a worker restart', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-restart-'));
  const cursor = openFileBackfillCursor(path.join(dir, 'state.sqlite'));
  let clock = 300;
  const inventory = { listFileHintIds: ({ afterFileId }) =>
    [7, 8].filter((id) => id > afterFileId).slice(0, 1),
  getFile: () => ({ state: 'linked', updated: candidate(1).updated,
    observedMs: 100 }) };
  const makeWorker = () => createFileBackfillWorker({ cursor, inventory,
    readCandidate: async ({ fileId }) => fileId === 7
      ? { state: 'unavailable' } : { ...candidate(1), fileId },
    resolveKind: async () => 'series',
    observeCandidate: async () => ({ state: 'unknown' }),
    proofs: { observeGuarded: () => { throw Error('No positive'); } },
    now: () => clock });
  try {
    assert.deepEqual(await makeWorker().runOnce(), {
      state: 'held', reason: 'source_read_unavailable' });
    clock += 15 * 60_000;
    const restarted = makeWorker();
    assert.equal((await restarted.runOnce()).state, 'checked');
    assert.equal((await restarted.runOnce()).state, 'checked');
  } finally { cursor.close(); await rm(dir, { recursive: true, force: true }); }
});

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
    assert.deepEqual(await worker.runOnce(), {
      state: 'held', reason: 'source_read_unavailable' });
    assert.deepEqual(await worker.runOnce(), { state: 'checked',
      checkedPairs: 0, available: 0, load: {
        cardReads: 0, physicalProbes: 0 } });
  } finally { cursor.close(); await rm(dir, { recursive: true, force: true }); }
});

test('Shoko link ordering changes do not skip a resumed episode', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-order-'));
  const cursor = openFileBackfillCursor(path.join(dir, 'state.sqlite'));
  const seen = [];
  const saved = [];
  let reads = 0;
  const worker = createFileBackfillWorker({ cursor,
    inventory: {
      listFileHintIds: ({ afterFileId }) =>
        [7].filter((id) => id > afterFileId),
      getFile: () => ({ state: 'linked', updated: candidate().updated,
        observedMs: 100 }),
    },
    readCandidate: async () => {
      const item = { ...candidate(),
        sourcePaths: ['/pure/Anime/pack.mkv', '/pure/Import/pack.mkv'] };
      return ++reads % 2 === 0 ? { ...item,
        pairs: [...item.pairs].reverse(),
        identities: [...item.identities].reverse(),
        sourcePaths: [...item.sourcePaths].reverse() } : item;
    },
    resolveKind: async () => 'series',
    observeCandidate: async ({ target, budget }) => {
      seen.push(target.episodeId);
      budget.cardReads++;
      return { state: 'available', fileId: 7,
        proof: { fileId: 7, libraryId: 102, ratingKey: 500,
          partId: 600, storageKey: '1:2:5' },
        cardRevision: { observedMs: 100, identitySignature: 'synthetic' } };
    },
    proofs: { observeGuarded: ({ episodeId }) => {
      saved.push(episodeId);
      return { state: 'recorded' };
    } }, now: () => 300, maxPairChecks: 10 });
  try {
    assert.equal((await worker.runOnce()).state, 'partial');
    assert.equal((await worker.runOnce()).state, 'checked');
    assert.deepEqual(seen, Array.from({ length: 12 },
      (_, index) => 1001 + index));
    assert.deepEqual(saved, seen);
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

test('a changed episode identity remains different after ordering normalization', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-identity-'));
  const cursor = openFileBackfillCursor(path.join(dir, 'state.sqlite'));
  let reads = 0;
  let writes = 0;
  const worker = createFileBackfillWorker({ cursor,
    inventory: { listFileHintIds: ({ afterFileId }) =>
      [7].filter((id) => id > afterFileId),
    getFile: () => ({ state: 'linked', updated: candidate(2).updated,
      observedMs: 100 }) },
    readCandidate: async () => {
      const item = candidate(2);
      return ++reads === 1 ? item : { ...item,
        pairs: [item.pairs[1], { anidbId: 42, episodeId: 1003 }] };
    },
    resolveKind: async () => 'series',
    observeCandidate: async () => ({ state: 'available', fileId: 7,
      proof: { fileId: 7, libraryId: 102, ratingKey: 500,
        partId: 600, storageKey: '1:2:5' },
      cardRevision: { observedMs: 100, identitySignature: 'synthetic' } }),
    proofs: { observeGuarded: () => { writes++; return { state: 'recorded' }; } },
    now: () => 300 });
  try {
    assert.equal((await worker.runOnce()).state, 'checked');
    assert.equal(writes, 0);
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

test('a read budget exhausted on the first pair is reported while later files continue', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-budget-'));
  const cursor = openFileBackfillCursor(path.join(dir, 'state.sqlite'));
  const observed = [];
  const inventory = { listFileHintIds: ({ afterFileId }) =>
    [7, 8].filter((id) => id > afterFileId).slice(0, 1),
  getFile: () => ({ state: 'linked', updated: candidate(1).updated,
    observedMs: 100 }) };
  const worker = createFileBackfillWorker({ cursor, inventory,
    readCandidate: async ({ fileId }) => ({ ...candidate(1), fileId }),
    resolveKind: async () => 'series',
    observeCandidate: async ({ candidate: file }) => {
      observed.push(file.fileId);
      return observed.length === 1
        ? { state: 'unknown', reason: 'read_budget_exhausted' }
        : { state: 'unknown' };
    },
    proofs: { observeGuarded: () => { throw Error('No positive'); } },
    now: () => 300 });
  try {
    assert.deepEqual(await worker.runOnce(),
      { state: 'checked', reason: 'read_budget_exhausted',
        checkedPairs: 0, available: 0,
        load: { cardReads: 0, physicalProbes: 0 } });
    assert.equal((await worker.runOnce()).state, 'checked');
    assert.deepEqual(observed, [7, 8]);
  } finally { cursor.close(); await rm(dir, { recursive: true, force: true }); }
});

test('an opt-in tick checks two distinct files under one shared read budget', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-batch-'));
  const cursor = openFileBackfillCursor(path.join(dir, 'state.sqlite'));
  const seen = [];
  const worker = createFileBackfillWorker({ cursor,
    inventory: { listFileHintIds: ({ afterFileId }) =>
      [7, 8].filter((id) => id > afterFileId).slice(0, 1),
    getFile: () => ({ state: 'linked', updated: candidate(1).updated,
      observedMs: 100 }) },
    readCandidate: async ({ fileId }) => ({ ...candidate(1), fileId,
      pairs: [{ anidbId: 42, episodeId: 1000 + fileId }] }),
    resolveKind: async () => 'series',
    observeCandidate: async ({ candidate: file, budget }) => {
      seen.push(file.fileId);
      budget.cardReads++;
      return { state: 'unknown' };
    },
    proofs: { observeGuarded: () => { throw Error('No positive'); } },
    now: () => 300, maxFilesPerTick: 2 });
  try {
    assert.deepEqual(await worker.runOnce(), { state: 'checked',
      checkedFiles: 2, checkedPairs: 2, available: 0,
      load: { cardReads: 2, physicalProbes: 0 } });
    assert.deepEqual(seen, [7, 8]);
  } finally { cursor.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a busy second file retains the first file progress and shared load', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-batch-busy-'));
  const cursor = openFileBackfillCursor(path.join(dir, 'state.sqlite'));
  let secondReads = 0;
  const worker = createFileBackfillWorker({ cursor,
    inventory: { listFileHintIds: ({ afterFileId }) =>
      [7, 8].filter((id) => id > afterFileId).slice(0, 1),
    getFile: () => ({ state: 'linked', updated: candidate(1).updated,
      observedMs: 100 }) },
    readCandidate: async ({ fileId }) => {
      if (fileId === 8 && ++secondReads === 1) return { state: 'busy' };
      return { ...candidate(1), fileId };
    },
    resolveKind: async () => 'series',
    observeCandidate: async ({ budget }) => {
      budget.cardReads++;
      return { state: 'unknown' };
    },
    proofs: { observeGuarded: () => { throw Error('No positive'); } },
    now: () => 300, maxFilesPerTick: 2 });
  try {
    assert.deepEqual(await worker.runOnce(), { state: 'held',
      reason: 'metadata_busy', checkedFiles: 1, checkedPairs: 1,
      available: 0, load: { cardReads: 1, physicalProbes: 0 } });
    assert.deepEqual(await worker.runOnce(), { state: 'checked',
      checkedFiles: 2, checkedPairs: 2, available: 0,
      load: { cardReads: 2, physicalProbes: 0 } });
  } finally { cursor.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a multi-file tick stops at its shared card budget and resumes next file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-batch-limit-'));
  const cursor = openFileBackfillCursor(path.join(dir, 'state.sqlite'));
  const seen = [];
  const worker = createFileBackfillWorker({ cursor,
    inventory: { listFileHintIds: ({ afterFileId }) =>
      [7, 8, 9].filter((id) => id > afterFileId).slice(0, 1),
    getFile: () => ({ state: 'linked', updated: candidate(1).updated,
      observedMs: 100 }) },
    readCandidate: async ({ fileId }) => ({ ...candidate(1), fileId }),
    resolveKind: async () => 'series',
    observeCandidate: async ({ candidate: file, budget }) => {
      seen.push(file.fileId);
      budget.cardReads += file.fileId === 7 ? 10 : 1;
      return { state: 'unknown' };
    },
    proofs: { observeGuarded: () => { throw Error('No positive'); } },
    now: () => 300, maxFilesPerTick: 2 });
  try {
    assert.deepEqual(await worker.runOnce(), { state: 'checked',
      checkedFiles: 1, checkedPairs: 1, available: 0,
      load: { cardReads: 10, physicalProbes: 0 } });
    assert.deepEqual(seen, [7]);
    assert.equal((await worker.runOnce()).checkedFiles, 2);
    assert.deepEqual(seen, [7, 8, 9]);
  } finally { cursor.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a multi-file tick does not revisit a file when its cursor wraps', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-batch-wrap-'));
  const cursor = openFileBackfillCursor(path.join(dir, 'state.sqlite'));
  const seen = [];
  const worker = createFileBackfillWorker({ cursor,
    inventory: { listFileHintIds: ({ afterFileId }) =>
      [7, 8].filter((id) => id > afterFileId).slice(0, 1),
    getFile: () => ({ state: 'linked', updated: candidate(1).updated,
      observedMs: 100 }) },
    readCandidate: async ({ fileId }) => ({ ...candidate(1), fileId }),
    resolveKind: async () => 'series',
    observeCandidate: async ({ candidate: file }) => {
      seen.push(file.fileId);
      return { state: 'unknown' };
    },
    proofs: { observeGuarded: () => { throw Error('No positive'); } },
    now: () => 300, maxFilesPerTick: 3 });
  try {
    assert.equal((await worker.runOnce()).checkedFiles, 2);
    assert.deepEqual(seen, [7, 8]);
    assert.equal((await worker.runOnce()).checkedFiles, 2);
    assert.deepEqual(seen, [7, 8, 7, 8]);
  } finally { cursor.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a multi-file tick still reports a deferred over-budget file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-file-batch-defer-'));
  const cursor = openFileBackfillCursor(path.join(dir, 'state.sqlite'));
  const worker = createFileBackfillWorker({ cursor,
    inventory: { listFileHintIds: ({ afterFileId }) =>
      [7, 8].filter((id) => id > afterFileId).slice(0, 1),
    getFile: () => ({ state: 'linked', updated: candidate(1).updated,
      observedMs: 100 }) },
    readCandidate: async ({ fileId }) => ({ ...candidate(1), fileId }),
    resolveKind: async () => 'series',
    observeCandidate: async ({ candidate: file }) => file.fileId === 7
      ? { state: 'unknown', reason: 'read_budget_exhausted' }
      : { state: 'unknown' },
    proofs: { observeGuarded: () => { throw Error('No positive'); } },
    now: () => 300, maxFilesPerTick: 2 });
  try {
    assert.deepEqual(await worker.runOnce(), { state: 'checked',
      checkedFiles: 1, deferredFiles: 1, checkedPairs: 1, available: 0,
      load: { cardReads: 0, physicalProbes: 0 } });
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
