import assert from 'node:assert/strict';
import { lstat, mkdtemp, open, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ed2kBuffer, ed2kFile } from '../src/identity/ed2k.mjs';

const CHUNK_SIZE = 9_728_000;

test('single-block ED2K matches the published MD4 abc vector', () => {
  assert.equal(ed2kBuffer(Buffer.from('abc')), 'A448017AAF21D8525FC10AE87AA6729D');
});

test('exactly one ED2K chunk uses its MD4 digest', () => {
  assert.equal(
    ed2kBuffer(Buffer.alloc(CHUNK_SIZE)),
    'D7DEF262A127CD79096A108E7A9FC138',
  );
});

test('a partial second chunk hashes the concatenated chunk digests', () => {
  assert.equal(
    ed2kBuffer(Buffer.alloc(CHUNK_SIZE + 1)),
    '06329E9DBA1373512C06386FE29E3C65',
  );
});

test('two exact chunks use the modern ED2K boundary without an empty trailing chunk', () => {
  // Independently calculated with OpenSSL's MD4: MD4(MD4(chunk) || MD4(chunk)).
  // The historical eMule variant appends MD4(empty) and gives 114B21C6...
  assert.equal(
    ed2kBuffer(Buffer.alloc(CHUNK_SIZE * 2)),
    '194EE9E4FA79B2EE9F8829284C466051',
  );
});

test('file hashing streams the same bytes as buffer hashing', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-ed2k-'));
  const file = path.join(dir, 'vector.bin');
  try {
    const handle = await open(file, 'w');
    try {
      await handle.writeFile(Buffer.alloc(CHUNK_SIZE + 1));
    } finally {
      await handle.close();
    }
    assert.deepEqual(await ed2kFile(file), {
      ed2k: '06329E9DBA1373512C06386FE29E3C65',
      size: CHUNK_SIZE + 1,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('file hashing reports bytes to the shared pacer', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-ed2k-paced-'));
  const file = path.join(dir, 'tiny.bin');
  const counts = [];
  try {
    const handle = await open(file, 'w');
    try { await handle.writeFile(Buffer.from('abc')); }
    finally { await handle.close(); }
    assert.deepEqual(await ed2kFile(file, { pacer: { afterBytes: async (count) => counts.push(count) } }),
      { ed2k: 'A448017AAF21D8525FC10AE87AA6729D', size: 3 });
    assert.deepEqual(counts, [3]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('file hashing yields during a full AniDB chunk without changing the hash', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-ed2k-yield-'));
  const file = path.join(dir, 'chunk.bin');
  let yields = 0;
  try {
    await writeFile(file, Buffer.alloc(CHUNK_SIZE));
    const result = await ed2kFile(file, { yieldCpu: async () => { yields++; } });
    assert.equal(result.ed2k, 'D7DEF262A127CD79096A108E7A9FC138');
    assert.ok(yields >= 8, `expected bounded CPU segments, saw ${yields}`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('staged file hashing rejects a path replaced after validation', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-ed2k-swap-'));
  const file = path.join(dir, 'episode.mkv');
  try {
    await writeFile(file, 'abc');
    const expectedStat = await lstat(file, { bigint: true });
    try { await rename(file, path.join(dir, 'original.mkv')); }
    catch (error) {
      if (error.code === 'EPERM' && process.platform === 'win32') {
        t.skip('Windows sandbox denies local rename; Linux CI exercises the swap');
        return;
      }
      throw error;
    }
    await writeFile(file, 'xyz');
    await assert.rejects(() => ed2kFile(file, { expectedStat }), /File changed/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('file hashing rejects an in-place edit even when mtime is restored', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-ed2k-edit-'));
  const file = path.join(dir, 'episode.mkv');
  const fixed = new Date('2020-01-01T00:00:00.000Z');
  try {
    await writeFile(file, 'abc');
    await utimes(file, fixed, fixed);
    const before = await stat(file, { bigint: true });
    await assert.rejects(() => ed2kFile(file, {
      expectedStat: before,
      pacer: { afterBytes: async () => {
        await writeFile(file, 'xyz');
        await utimes(file, fixed, fixed);
        const after = await stat(file, { bigint: true });
        assert.equal(after.mtimeNs, before.mtimeNs);
        assert.notEqual(after.ctimeNs, before.ctimeNs);
      } },
    }), /File changed/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
