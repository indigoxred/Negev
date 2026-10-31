import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ed2kBuffer, ed2kFile } from '../src/identity/ed2k.mjs';
import { prepareHandoffBatch } from '../src/acquisition/prepare-handoff-batch.mjs';

async function withRoots(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-handoff-'));
  const stagingRoot = path.join(root, 'staging');
  const holdingRoot = path.join(root, 'holding');
  const importRoot = path.join(root, 'import');
  await Promise.all([stagingRoot, holdingRoot, importRoot].map((dir) => mkdir(dir)));
  try { await run({ stagingRoot, holdingRoot, importRoot }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

const bytes = Buffer.from('abc');
const file = { name: 'Show/01.mkv', episodeIds: [1001], anidbFileId: 51,
  ed2k: ed2kBuffer(bytes), size: bytes.length };
const verified = { state: 'batch_identity_verified', files: [file], subtitles: [],
  handoffReady: false };

test('copies verified bytes into private holding and leaves Shoko Import empty', async () =>
  withRoots(async (roots) => {
    await mkdir(path.join(roots.stagingRoot, 'Show'));
    await writeFile(path.join(roots.stagingRoot, file.name), bytes);
    const paced = [];
    const result = await prepareHandoffBatch({ ...roots, verified,
      readPacer: { afterBytes: async (count) => paced.push(count) } });
    assert.equal(result.state, 'handoff_prepared');
    assert.equal(result.publishReady, false);
    assert.equal(result.files[0].anidbFileId, 51);
    assert.deepEqual(await readdir(roots.importRoot), []);
    assert.deepEqual(await readFile(path.join(result.holdingPath, file.name)), bytes);
    assert.deepEqual(await ed2kFile(path.join(result.holdingPath, file.name)),
      { ed2k: file.ed2k, size: bytes.length });
    assert.ok(paced.reduce((sum, count) => sum + count, 0) >= bytes.length * 2);
  }));

test('wrong source bytes cannot prepare a handoff and never reach Import', async () =>
  withRoots(async (roots) => {
    await mkdir(path.join(roots.stagingRoot, 'Show'));
    await writeFile(path.join(roots.stagingRoot, file.name), 'different');
    const result = await prepareHandoffBatch({ ...roots, verified });
    assert.deepEqual(result, { state: 'held', reason: 'source_changed' });
    assert.deepEqual(await readdir(roots.importRoot), []);
    assert.deepEqual(await readdir(roots.holdingRoot), []);
  }));

test('a later bad video removes the private partial copy without touching either source', async () =>
  withRoots(async (roots) => {
    await mkdir(path.join(roots.stagingRoot, 'Show'));
    await writeFile(path.join(roots.stagingRoot, file.name), bytes);
    const second = { ...file, name: 'Show/02.mkv', episodeIds: [1002],
      anidbFileId: 52, ed2k: ed2kBuffer(Buffer.from('def')) };
    await writeFile(path.join(roots.stagingRoot, second.name), 'wrong');
    const result = await prepareHandoffBatch({ ...roots,
      verified: { ...verified, files: [file, second] } });
    assert.deepEqual(result, { state: 'held', reason: 'source_changed' });
    assert.deepEqual(await readdir(roots.holdingRoot), []);
    assert.deepEqual(await readdir(roots.importRoot), []);
    assert.deepEqual(await readFile(path.join(roots.stagingRoot, file.name)), bytes);
    assert.equal((await readFile(path.join(roots.stagingRoot, second.name))).toString(), 'wrong');
  }));

test('holding inside watched Import and unsafe names hold before copying', async () =>
  withRoots(async (roots) => {
    assert.deepEqual(await prepareHandoffBatch({ ...roots,
      holdingRoot: roots.importRoot, verified }),
    { state: 'held', reason: 'unsafe_handoff_roots' });
    assert.deepEqual(await prepareHandoffBatch({ ...roots,
      verified: { ...verified, files: [{ ...file, name: '../escape.mkv' }] } }),
    { state: 'held', reason: 'invalid_verified_batch' });
    assert.deepEqual(await readdir(roots.importRoot), []);
  }));

test('selected subtitles cannot be silently omitted from a prepared batch', async () =>
  withRoots(async (roots) => {
    assert.deepEqual(await prepareHandoffBatch({ ...roots,
      verified: { ...verified, subtitles: [{ index: 1, name: 'Show/01.en.srt', size: 5 }] } }),
    { state: 'held', reason: 'subtitle_handoff_not_ready' });
    assert.deepEqual(await readdir(roots.importRoot), []);
    assert.deepEqual(await readdir(roots.holdingRoot), []);
  }));
