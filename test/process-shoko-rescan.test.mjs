import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { processShokoRescan } from
  '../src/acquisition/process-shoko-rescan.mjs';

const manifest = {
  attemptId: 71, torrentHash: 'a'.repeat(40), files: [
    { name: 'group/01 [BD].mkv', size: 1001, episodeIds: [11] },
    { name: 'group/E02 - Title.mkv', size: 1002, episodeIds: [12] },
    { name: 'group/03.Title.mkv', size: 1003, episodeIds: [13] },
  ],
};
const item = { attemptId: 71, requestId: 9, anidbId: 42,
  publishedMs: 100, manifest };
const localRoot = path.join(tmpdir(), 'negev-rescan-source');
const importRoot = path.join(localRoot, 'Negev');
const shokoMount = { localRoot, appRoot: '/import' };
const linked = (fileId, episodeId, size, sourcePath) => ({
  ID: fileId, Size: size,
  Locations: [{ AbsolutePath: sourcePath, IsAccessible: true }],
  SeriesIDs: [{ SeriesID: { ID: 9, AniDB: 42 },
    EpisodeIDs: [{ AniDB: episodeId }] }],
});
const crossReferencedOnly = (fileId, episodeId, size, sourcePath) => ({
  ...linked(fileId, episodeId, size, sourcePath),
  SeriesIDs: [{ SeriesID: { ID: null, AniDB: 42 },
    EpisodeIDs: [{ AniDB: episodeId }] }],
});
const unknown = (fileId, size, sourcePath) => ({
  ID: fileId, Size: size,
  Locations: [{ AbsolutePath: sourcePath, IsAccessible: true }],
  SeriesIDs: [],
});
function witness() {
  const files = new Map();
  let completed = null;
  const ledger = {
    getFile: (_attemptId, name) => files.get(name) ?? null,
    observeFile({ fileName, fileId, nowMs }) {
      files.set(fileName, { fileId, status: 'observed',
        firstSeenMs: nowMs });
      return { state: 'observed' };
    },
    beginDispatch({ fileName, fileId, nowMs }) {
      const prior = files.get(fileName);
      if (prior.status !== 'observed' || prior.fileId !== fileId ||
          nowMs - prior.firstSeenMs < 60_000) {
        return { state: 'held', reason: 'rescan_not_confirmed' };
      }
      files.set(fileName, { ...prior, status: 'dispatched',
        updatedMs: nowMs });
      return { state: 'dispatched' };
    },
    markLinked({ fileName, fileId }) {
      const prior = files.get(fileName);
      files.set(fileName, { ...prior, fileId, status: 'linked' });
      return { state: 'linked' };
    },
    markUnresolved({ fileName }) {
      files.set(fileName, { ...files.get(fileName), status: 'unresolved' });
      return { state: 'unresolved' };
    },
    delayAttempt() {},
    endAttempt({ review }) { completed = review ? 'review' : 'done'; },
  };
  return { ledger, files, completion: () => completed };
}

test('rescans only two exact unlinked files in a mixed-layout season pack', async () => {
  const saved = witness();
  const missing = new Set([12, 13]);
  const calls = [];
  const options = {
    item, ledger: saved.ledger, importRoot, shokoMount,
    verifyPlex: async ({ episodeId }) => ({ state: missing.has(episodeId)
      ? 'unknown' : 'available',
      fileId: episodeId + 69 }),
    readQueue: async () => ({ state: 'queue_idle_unverified' }),
    readFile: async ({ sourcePath }) => {
      const index = manifest.files.findIndex((file) =>
        sourcePath.endsWith(file.name));
      const file = manifest.files[index];
      return [missing.has(file.episodeIds[0])
        ? unknown(80 + index, file.size, sourcePath)
        : linked(80 + index, file.episodeIds[0], file.size, sourcePath)];
    },
    rescan: async ({ fileId }) => { calls.push(fileId);
      return { state: 'accepted' }; },
  };
  assert.equal((await processShokoRescan({ ...options,
    nowMs: 300_100 })).state, 'observed');
  assert.deepEqual(calls, []);
  assert.equal((await processShokoRescan({ ...options,
    nowMs: 360_100 })).state, 'rescan_requested');
  assert.deepEqual(calls, [81]);
  assert.equal((await processShokoRescan({ ...options,
    nowMs: 360_101 })).state, 'awaiting_shoko');
  assert.deepEqual(calls, [81]);
  missing.delete(12);
  assert.equal((await processShokoRescan({ ...options,
    nowMs: 420_100 })).state, 'observed');
  assert.equal((await processShokoRescan({ ...options,
    nowMs: 480_100 })).state, 'rescan_requested');
  assert.deepEqual(calls, [81, 82]);
  missing.delete(13);
  assert.equal((await processShokoRescan({ ...options,
    nowMs: 540_100 })).state, 'linked');
  assert.equal(saved.completion(), 'done');
});

test('rescan resolves a verified Shoko Source mounted separately from Negev handoff', async () => {
  const saved = witness();
  const sourcePath = '/pure/.negev-handoff/source/Negev/negev-71-aaaaaaaaaaaaaaaa/group/01 [BD].mkv';
  const result = await processShokoRescan({
    item: { ...item, manifest: { ...manifest, files: [manifest.files[0]] } },
    ledger: saved.ledger,
    importRoot: path.join(tmpdir(), 'handoff', 'source', 'Negev'),
    shokoMount: { localRoot: path.join(tmpdir(), 'pure'), appRoot: '/pure' },
    shokoSourcePath: '/pure/.negev-handoff/source',
    nowMs: 300_100,
    readQueue: async () => ({ state: 'queue_idle_unverified' }),
    readFile: async ({ sourcePath: observed }) => {
      assert.equal(observed, sourcePath);
      return [unknown(80, manifest.files[0].size, observed)];
    },
    rescan: async () => { throw Error('Not due yet'); },
    verifyPlex: async () => ({ state: 'unknown' }),
  });
  assert.equal(result.state, 'observed');
  assert.equal(saved.completion(), null);
});

test('an exact AniDB cross-reference without a local Shoko series is rescanned once', async () => {
  const saved = witness();
  const single = { ...item, manifest: { ...manifest, files: [manifest.files[0]] } };
  const calls = [];
  const options = { item: single, ledger: saved.ledger, importRoot,
    shokoMount, readQueue: async () => ({ state: 'queue_idle_unverified' }),
    readFile: async ({ sourcePath }) => [crossReferencedOnly(80, 11,
      manifest.files[0].size, sourcePath)],
    rescan: async ({ fileId }) => { calls.push(fileId);
      return { state: 'accepted' }; },
    verifyPlex: async () => ({ state: 'unknown' }),
  };
  assert.equal((await processShokoRescan({ ...options,
    nowMs: 300_100 })).state, 'observed');
  assert.equal((await processShokoRescan({ ...options,
    nowMs: 360_100 })).state, 'rescan_requested');
  assert.deepEqual(calls, [80]);
  assert.equal(saved.completion(), null);
});

test('a moved exact file completes only after its own Plex episode is verified', async () => {
  const saved = witness();
  saved.files.set(manifest.files[0].name, { fileId: 80,
    status: 'dispatched', firstSeenMs: 300_100, updatedMs: 360_100 });
  const single = { ...item, manifest: { ...manifest, files: [manifest.files[0]] } };
  const options = { item: single, ledger: saved.ledger, importRoot,
    shokoMount, readQueue: async () => ({ state: 'queue_idle_unverified' }),
    readFile: async () => [], rescan: async () => {
      throw Error('No second rescan'); },
    verifyPlex: async () => ({ state: 'unknown' }),
  };
  assert.notEqual((await processShokoRescan({ ...options,
    nowMs: 420_100 })).state, 'linked');
  assert.equal(saved.completion(), null);
  assert.equal((await processShokoRescan({ ...options,
    verifyPlex: async () => ({ state: 'available', fileId: 80 }),
    nowMs: 480_100 })).state, 'linked');
  assert.equal(saved.completion(), 'done');
});

test('a busy queue, wrong file, or conflicting identity cannot trigger rescan', async () => {
  for (const state of ['busy', 'wrong_path', 'wrong_size',
    'wrong_identity']) {
    const saved = witness();
    let calls = 0;
    const result = await processShokoRescan({ item, ledger: saved.ledger,
      importRoot, shokoMount,
      verifyPlex: async ({ episodeId }) => ({ state: 'available',
        fileId: episodeId + 69 }),
      nowMs: 300_100,
      readQueue: async () => ({ state: state === 'busy' ? 'busy' :
        'queue_idle_unverified' }),
      readFile: async ({ sourcePath }) => {
        const file = manifest.files[0];
        return [state === 'wrong_identity'
          ? { ...linked(80, 11, file.size, sourcePath),
            SeriesIDs: [{ SeriesID: { AniDB: 99 },
              EpisodeIDs: [{ AniDB: 11 }] }] }
          : unknown(80, state === 'wrong_size' ? 999 : file.size,
            state === 'wrong_path'
            ? '/import/elsewhere.mkv' : sourcePath)];
      },
      rescan: async () => { calls++; return { state: 'accepted' }; },
    });
    assert.notEqual(result.state, 'rescan_requested');
    assert.equal(calls, 0);
    if (state === 'wrong_identity') {
      assert.equal(saved.completion(), 'review');
    }
  }
});

test('a manifest path cannot escape its published Negev tree', async () => {
  const saved = witness();
  saved.files.set('../outside.mkv', { fileId: 81, status: 'observed',
    firstSeenMs: 300_100 });
  let calls = 0;
  const result = await processShokoRescan({
    item: { ...item, manifest: { ...manifest, files: [
      { name: '../outside.mkv', size: 1000, episodeIds: [11] },
    ] } },
    ledger: saved.ledger, importRoot, shokoMount, nowMs: 360_100,
    verifyPlex: async ({ episodeId }) => ({ state: 'available',
      fileId: episodeId + 69 }),
    readQueue: async () => ({ state: 'queue_idle_unverified' }),
    readFile: async ({ sourcePath }) => [unknown(81, 1000, sourcePath)],
    rescan: async () => { calls++; return { state: 'accepted' }; },
  });
  assert.equal(result.state, 'held');
  assert.equal(calls, 0);
});

test('does not complete recovery until Plex verifies every episode', async () => {
  const saved = witness();
  saved.files.set(manifest.files[1].name, { fileId: 81,
    status: 'dispatched', firstSeenMs: 200_000, updatedMs: 200_000 });
  const result = await processShokoRescan({ item, ledger: saved.ledger,
    importRoot, shokoMount, nowMs: 300_100,
    readQueue: async () => ({ state: 'queue_idle_unverified' }),
    readFile: async ({ sourcePath }) => {
      const video = manifest.files.find((file) => sourcePath.endsWith(file.name));
      return [linked(81, video.episodeIds[0], video.size, sourcePath)];
    },
    rescan: async () => { throw new Error('No rescan needed'); },
    verifyPlex: async ({ episodeId }) => ({ state: episodeId === 12
      ? 'unknown' : 'available', fileId: 81 }),
  });
  assert.equal(result.state, 'awaiting_plex');
  assert.equal(saved.completion(), null);
});

test('another playable copy cannot complete the rescanned file proof', async () => {
  const saved = witness();
  saved.files.set(manifest.files[1].name, { fileId: 81,
    status: 'dispatched', firstSeenMs: 200_000, updatedMs: 200_000 });
  const result = await processShokoRescan({ item, ledger: saved.ledger,
    importRoot, shokoMount, nowMs: 300_100,
    readQueue: async () => ({ state: 'queue_idle_unverified' }),
    readFile: async ({ sourcePath }) => {
      const video = manifest.files.find((file) => sourcePath.endsWith(file.name));
      return [linked(81, video.episodeIds[0], video.size, sourcePath)];
    },
    rescan: async () => { throw new Error('No rescan needed'); },
    verifyPlex: async () => ({ state: 'available', fileId: 999 }),
  });
  assert.equal(result.state, 'awaiting_plex');
  assert.equal(saved.completion(), null);
});
