import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyStagedBatch } from '../src/acquisition/verify-staged-batch.mjs';
import { ed2kBuffer } from '../src/identity/ed2k.mjs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const request = { anidbId: 42, episodeIds: [1001, 1002], status: 'held' };
const expectedTorrent = { hash: 'a'.repeat(40), category: 'negev', savePath: '/staging' };
const files = [{ index: 0, name: 'Show/01.mkv', size: 3 },
  { index: 1, name: 'Show/02.mkv', size: 3 }];
const plannedFiles = [{ name: 'Show/01.mkv', episodeIds: [1001] },
  { name: 'Show/02.mkv', episodeIds: [1002] }];

test('checks each selected file in sequence and rechecks torrent before reporting evidence', async () => {
  const calls = [];
  const readPacer = { afterBytes: async () => {} };
  const result = await verifyStagedBatch({ root: '/staging', request, expectedTorrent, plannedFiles,
    readPacer,
    observe: async () => { calls.push('observe'); return { state: 'complete', files }; },
    verify: async ({ relativePath, expected, readPacer: suppliedPacer }) => {
      calls.push(relativePath);
      assert.equal(suppliedPacer, readPacer);
      assert.equal(expected.animeId, 42);
      return { state: 'identity_verified', fileId: relativePath.includes('01') ? 51 : 52,
        ed2k: 'B'.repeat(32), size: 3 };
    },
    lookup: async () => { throw Error('mock verify must handle lookup'); },
  });
  assert.deepEqual(calls, ['observe', 'Show/01.mkv', 'Show/02.mkv', 'observe']);
  assert.equal(result.state, 'batch_identity_verified');
  assert.equal(result.handoffReady, false);
  assert.deepEqual(result.files.map((file) => file.anidbFileId), [51, 52]);
});

test('one wrong or unavailable file holds the whole batch and stops later hashing', async () => {
  const calls = [];
  const result = await verifyStagedBatch({ root: '/staging', request, expectedTorrent, plannedFiles,
    observe: async () => ({ state: 'complete', files }),
    verify: async ({ relativePath }) => {
      calls.push(relativePath);
      return { state: 'rejected', reason: 'wrong_identity' };
    }, lookup: async () => null,
  });
  assert.deepEqual(result, { state: 'held', reason: 'file_wrong_identity' });
  assert.deepEqual(calls, ['Show/01.mkv']);
});

test('manifest mismatch, duplicate targets and byte budget stop before hashing', async () => {
  for (const change of [
    { plannedFiles: [plannedFiles[0]] },
    { plannedFiles: [{ ...plannedFiles[0], episodeIds: [1001, 1002] }, plannedFiles[1]] },
    { maxTotalBytes: 5 },
  ]) {
    let hashes = 0;
    const result = await verifyStagedBatch({ root: '/staging', request, expectedTorrent,
      plannedFiles, observe: async () => ({ state: 'complete', files }),
      verify: async () => { hashes++; throw Error('must not hash'); }, lookup: async () => null,
      ...change });
    assert.equal(result.state, 'held');
    assert.equal(hashes, 0);
  }
});

test('a changed torrent after hashing cannot pass the batch', async () => {
  let observations = 0;
  const result = await verifyStagedBatch({ root: '/staging', request, expectedTorrent, plannedFiles,
    observe: async () => ({ state: 'complete', files: ++observations === 1 ? files :
      [{ ...files[0], size: 4 }, files[1]] }),
    verify: async ({ relativePath }) => ({ state: 'identity_verified',
      fileId: relativePath.includes('01') ? 51 : 52, ed2k: 'B'.repeat(32), size: 3 }),
    lookup: async () => null,
  });
  assert.deepEqual(result, { state: 'held', reason: 'torrent_changed_after_hash' });
});

test('a changed selected subtitle after video hashing holds the pack', async () => {
  let observations = 0;
  const subtitle = { index: 2, name: 'Show/01.en.srt', size: 120 };
  const result = await verifyStagedBatch({ root: '/staging', request, expectedTorrent, plannedFiles,
    observe: async () => ({ state: 'complete', files,
      subtitles: [{ ...subtitle, size: ++observations === 1 ? 120 : 121 }] }),
    verify: async ({ relativePath }) => ({ state: 'identity_verified',
      fileId: relativePath.includes('01') ? 51 : 52, ed2k: 'B'.repeat(32), size: 3 }),
    lookup: async () => null,
  });
  assert.deepEqual(result, { state: 'held', reason: 'torrent_changed_after_hash' });
});

test('synthetic staged bytes pass only through exact AniDB file identities', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-batch-'));
  try {
    const bytes = [Buffer.from('abc'), Buffer.from('def')];
    await writeFile(path.join(root, '01.mkv'), bytes[0]);
    await writeFile(path.join(root, '02.mkv'), bytes[1]);
    const hashes = bytes.map(ed2kBuffer);
    const observations = [{ index: 0, name: '01.mkv', size: 3 },
      { index: 1, name: '02.mkv', size: 3 }];
    const result = await verifyStagedBatch({ root, request, expectedTorrent,
      plannedFiles: [{ name: '01.mkv', episodeIds: [1001] },
        { name: '02.mkv', episodeIds: [1002] }],
      observe: async () => ({ state: 'complete', files: observations }),
      lookup: async ({ ed2k, size }) => {
        const index = hashes.indexOf(ed2k);
        return { status: 200, release: {
          id: `anidb://${ed2k}+${size}`, providerName: 'AniDB',
          releaseURI: `https://anidb.net/file/${51 + index}`, fileSize: size,
          hashes: [{ type: 'ED2K', value: ed2k }],
          crossReferences: [{ anidbAnimeID: 42, anidbEpisodeID: 1001 + index }],
        } };
      },
    });
    assert.equal(result.state, 'batch_identity_verified');
    assert.deepEqual(result.files.map((file) => file.anidbFileId), [51, 52]);
    assert.equal(result.handoffReady, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
