import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { verifyStagedFile } from '../src/identity/verify-staged-file.mjs';

const expected = {
  animeId: 42,
  episodeIds: [1001],
};
const ed2k = 'A448017AAF21D8525FC10AE87AA6729D'; // published MD4 “abc” vector

function matchingPreview({ size }) {
  return { status: 200, release: {
    id: `anidb://${ed2k}+${size}`,
    providerName: 'AniDB',
    releaseURI: 'https://anidb.net/file/123456',
    fileSize: size,
    hashes: [{ type: 'ED2K', value: ed2k }],
    crossReferences: [{ anidbAnimeID: 42, anidbEpisodeID: 1001 }],
  } };
}

async function withStage(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'negev-stage-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('verifies an exact file inside staging without importing or moving it', async () => {
  await withStage(async (root) => {
    await writeFile(path.join(root, 'episode.mkv'), 'abc');
    const result = await verifyStagedFile({ root, relativePath: 'episode.mkv', expected, lookup: async (hash) => {
      assert.deepEqual(hash, { ed2k, size: 3 });
      return matchingPreview(hash);
    } });
    assert.deepEqual(result, { state: 'identity_verified', fileId: 123456, ed2k, size: 3 });
  });
});

test('rejects traversal and absolute paths before a lookup', async () => {
  await withStage(async (root) => {
    const lookup = async () => { throw Error('lookup must not run'); };
    for (const relativePath of ['../outside.mkv', path.resolve(root, 'episode.mkv')]) {
      assert.deepEqual(await verifyStagedFile({ root, relativePath, expected, lookup }), {
        state: 'held', reason: 'path_outside_staging',
      });
    }
  });
});

test('rejects a directory as a candidate video', async () => {
  await withStage(async (root) => {
    await mkdir(path.join(root, 'folder.mkv'));
    assert.deepEqual(await verifyStagedFile({ root, relativePath: 'folder.mkv', expected, lookup: async () => { throw Error('lookup must not run'); } }), {
      state: 'held', reason: 'non_regular_file',
    });
  });
});

test('holds executable files before hashing or contacting Shoko', async () => {
  await withStage(async (root) => {
    await writeFile(path.join(root, 'episode.mkv.exe'), 'abc');
    assert.deepEqual(await verifyStagedFile({ root, relativePath: 'episode.mkv.exe', expected, lookup: async () => { throw Error('lookup must not run'); } }), {
      state: 'held', reason: 'unsupported_file_type',
    });
  });
});

test('rejects a symlink in the staging tree', async (t) => {
  await withStage(async (root) => {
    await writeFile(path.join(root, 'episode.mkv'), 'abc');
    try { await symlink(path.join(root, 'episode.mkv'), path.join(root, 'linked.mkv')); }
    catch (error) {
      if (error.code === 'EPERM') { t.skip('Windows account cannot create symlinks'); return; }
      throw error;
    }
    assert.deepEqual(await verifyStagedFile({ root, relativePath: 'linked.mkv', expected, lookup: async () => { throw Error('lookup must not run'); } }), {
      state: 'held', reason: 'symlink_in_staging',
    });
  });
});

test('holds a staged file when the provider is unavailable', async () => {
  await withStage(async (root) => {
    await writeFile(path.join(root, 'episode.mkv'), 'abc');
    assert.deepEqual(await verifyStagedFile({ root, relativePath: 'episode.mkv', expected, lookup: async () => ({ status: 401 }) }), {
      state: 'held', reason: 'provider_unavailable',
    });
  });
});

test('rejects an over-budget staged file before hashing or provider lookup', async () => {
  await withStage(async (root) => {
    await writeFile(path.join(root, 'episode.mkv'), 'abc');
    assert.deepEqual(await verifyStagedFile({ root, relativePath: 'episode.mkv',
      expected, maxFileBytes: 2, lookup: async () => { throw Error('must not look up'); } }),
    { state: 'held', reason: 'file_over_budget' });
  });
});
