import assert from 'node:assert/strict';
import { mkdtemp, open, rm } from 'node:fs/promises';
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
