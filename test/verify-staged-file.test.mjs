import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { verifyStagedFile } from '../src/identity/verify-staged-file.mjs';
import { ED2K_CHUNK_SIZE } from '../src/identity/ed2k.mjs';

const expected = {
  animeId: 42,
  episodeIds: [1001],
};
const ed2k = 'A448017AAF21D8525FC10AE87AA6729D'; // published MD4 “abc” vector

function matchingPreview({ size, digest = ed2k }) {
  return { status: 200, release: {
    id: `anidb://${digest}+${size}`,
    providerName: 'AniDB',
    releaseURI: 'https://anidb.net/file/123456',
    fileSize: size,
    hashes: [{ type: 'ED2K', value: digest }],
    crossReferences: [{ anidbAnimeID: 42, anidbEpisodeID: 1001,
      percentageStart: null, percentageEnd: null }],
  } };
}

async function withStage(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'negev-stage-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('verifies an exact file inside staging without importing or moving it', async () => {
  await withStage(async (root) => {
    await writeFile(path.join(root, 'episode.mkv'), 'abc');
    const paced = [];
    const result = await verifyStagedFile({ root, relativePath: 'episode.mkv', expected,
      readPacer: { afterBytes: async (count) => paced.push(count) }, lookup: async (hash) => {
      assert.deepEqual(hash, { ed2k, size: 3 });
      return matchingPreview(hash);
    } });
    assert.deepEqual(result, { state: 'identity_verified', fileId: 123456,
      coverage: [{ episodeId: 1001, start: 0, end: 100 }], ed2k, size: 3 });
    assert.deepEqual(paced, [3]);
  });
});

test('holds an exact ED2K chunk boundary until Shoko hash mode is proven', async () => {
  await withStage(async (root) => {
    await writeFile(path.join(root, 'boundary.mkv'), Buffer.alloc(ED2K_CHUNK_SIZE));
    let lookups = 0;
    const result = await verifyStagedFile({ root, relativePath: 'boundary.mkv', expected,
      lookup: async () => { lookups++; return matchingPreview({ size: ED2K_CHUNK_SIZE }); } });
    assert.deepEqual(result, { state: 'held', reason: 'ed2k_boundary_mode_unverified' });
    assert.equal(lookups, 0);
  });
});

test('verifies the native RHash boundary only when its mode is supplied', async () => {
  await withStage(async (root) => {
    await writeFile(path.join(root, 'boundary.mkv'), Buffer.alloc(ED2K_CHUNK_SIZE));
    const digest = 'FC21D9AF828F92A8DF64BEAC3357425D';
    const result = await verifyStagedFile({ root, relativePath: 'boundary.mkv',
      expected, ed2kMode: 'emule', lookup: async (hash) => {
        assert.deepEqual(hash, { ed2k: digest, size: ED2K_CHUNK_SIZE });
        return matchingPreview({ size: hash.size, digest });
      } });
    assert.equal(result.state, 'identity_verified');
    assert.equal(result.ed2k, digest);
  });
});

test('holds an edit made during provider lookup even when mtime is restored', async () => {
  await withStage(async (root) => {
    const file = path.join(root, 'episode.mkv');
    const fixed = new Date('2020-01-01T00:00:00.000Z');
    await writeFile(file, 'abc');
    await utimes(file, fixed, fixed);
    const before = await stat(file, { bigint: true });
    const result = await verifyStagedFile({ root, relativePath: 'episode.mkv',
      expected, lookup: async (hash) => {
        await writeFile(file, 'xyz');
        await utimes(file, fixed, fixed);
        const after = await stat(file, { bigint: true });
        assert.equal(after.mtimeNs, before.mtimeNs);
        assert.notEqual(after.ctimeNs, before.ctimeNs);
        return matchingPreview(hash);
      } });
    assert.deepEqual(result, { state: 'held', reason: 'file_changed_or_unavailable' });
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

test('an explicit provisional check retains stable bytes when AniDB has no file result', async () => {
  await withStage(async (root) => {
    await writeFile(path.join(root, 'episode.mkv'), 'abc');
    const lookup = async () => ({ status: 204 });
    assert.deepEqual(await verifyStagedFile({ root, relativePath: 'episode.mkv',
      expected, lookup }), { state: 'held', reason: 'lookup_inconclusive' });
    assert.deepEqual(await verifyStagedFile({ root, relativePath: 'episode.mkv',
      expected, lookup, allowProvisional: true }),
    { state: 'hash_verified', reason: 'lookup_inconclusive', ed2k, size: 3 });
  });
});

test('a provisional check never turns a wrong AniDB identity into a hash-only pass', async () => {
  await withStage(async (root) => {
    await writeFile(path.join(root, 'episode.mkv'), 'abc');
    const preview = matchingPreview({ size: 3 });
    preview.release.crossReferences[0].anidbEpisodeID = 9000;
    assert.deepEqual(await verifyStagedFile({ root, relativePath: 'episode.mkv',
      expected, lookup: async () => preview, allowProvisional: true }),
    { state: 'rejected', reason: 'wrong_identity' });
  });
});

test('a provisional check cannot attach stable bytes to an invalid episode target', async () => {
  await withStage(async (root) => {
    await writeFile(path.join(root, 'episode.mkv'), 'abc');
    assert.deepEqual(await verifyStagedFile({ root, relativePath: 'episode.mkv',
      expected: { animeId: 42, episodeIds: [] },
      lookup: async () => ({ status: 204 }), allowProvisional: true }),
    { state: 'held', reason: 'lookup_inconclusive' });
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
