import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ED2K_CHUNK_SIZE, ed2kBuffer, ed2kFile } from '../src/identity/ed2k.mjs';
import { createHash } from 'node:crypto';
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
const verified = { state: 'batch_identity_verified', torrentHash: 'a'.repeat(40), anidbId: 42,
  files: [file], subtitles: [],
  handoffReady: false };

test('boundary copy needs the selected mode and rehashes with it', async () =>
  withRoots(async (roots) => {
    const boundary = Buffer.alloc(ED2K_CHUNK_SIZE);
    const boundaryFile = { ...file, size: boundary.length,
      ed2k: ed2kBuffer(boundary, { mode: 'emule' }) };
    const batch = { ...verified, files: [boundaryFile] };
    await mkdir(path.join(roots.stagingRoot, 'Show'));
    await writeFile(path.join(roots.stagingRoot, file.name), boundary);
    assert.deepEqual(await prepareHandoffBatch({ ...roots, verified: batch }),
      { state: 'held', reason: 'ed2k_boundary_mode_unverified' });
    assert.deepEqual(await readdir(roots.holdingRoot), []);
    const result = await prepareHandoffBatch({ ...roots, verified: batch,
      ed2kMode: 'emule', readPacer: { afterBytes: async () => {} } });
    assert.equal(result.state, 'handoff_prepared');
    assert.deepEqual(await ed2kFile(path.join(result.holdingPath, file.name),
      { mode: 'emule' }), { ed2k: boundaryFile.ed2k, size: boundary.length });
    assert.deepEqual(await readdir(roots.importRoot), []);
  }));

test('copies verified bytes into private holding and leaves Shoko Import empty', async () =>
  withRoots(async (roots) => {
    await mkdir(path.join(roots.stagingRoot, 'Show'));
    await writeFile(path.join(roots.stagingRoot, file.name), bytes);
    const paced = [];
    const result = await prepareHandoffBatch({ ...roots, verified,
      readPacer: { afterBytes: async (count) => paced.push(count) } });
    assert.equal(result.state, 'handoff_prepared');
    assert.equal(result.publishReady, false);
    assert.equal(result.torrentHash, verified.torrentHash);
    assert.match(result.evidenceDigest, /^[0-9a-f]{64}$/);
    assert.equal(result.files[0].anidbFileId, 51);
    assert.deepEqual(await readdir(roots.importRoot), []);
    assert.deepEqual(await readFile(path.join(result.holdingPath, file.name)), bytes);
    if (process.platform !== 'win32') {
      assert.equal((await stat(path.join(result.holdingPath, file.name))).mode & 0o777,
        0o644, 'published Shoko media must be readable by Plex after import');
    }
    assert.deepEqual(await ed2kFile(path.join(result.holdingPath, file.name)),
      { ed2k: file.ed2k, size: bytes.length });
    assert.ok(paced.reduce((sum, count) => sum + count, 0) >= bytes.length * 2);
  }));

test('a provisional single episode is copied privately with no fabricated file ID', async () =>
  withRoots(async (roots) => {
    await mkdir(path.join(roots.stagingRoot, 'Show'));
    await writeFile(path.join(roots.stagingRoot, file.name), bytes);
    const provisional = { ...verified, state: 'batch_provisional',
      identity: 'provisional', files: [{ name: file.name, size: file.size,
        ed2k: file.ed2k, episodeIds: [1001] }] };
    const result = await prepareHandoffBatch({ ...roots, verified: provisional,
      readPacer: { afterBytes: async () => {} } });
    assert.equal(result.state, 'handoff_prepared');
    assert.equal(result.identity, 'provisional');
    assert.equal(result.files[0].anidbFileId, undefined);
    assert.deepEqual(await readFile(path.join(result.holdingPath, file.name)), bytes);
    assert.deepEqual(await readdir(roots.importRoot), []);
  }));

test('a provisional Completed pack copies every verified episode privately', async () =>
  withRoots(async (roots) => {
    await mkdir(path.join(roots.stagingRoot, 'Show'));
    const second = { name: 'Show/02.mkv', size: bytes.length,
      ed2k: file.ed2k, episodeIds: [1002] };
    await Promise.all([file.name, second.name].map((name) =>
      writeFile(path.join(roots.stagingRoot, name), bytes)));
    const provisional = { ...verified, state: 'batch_provisional',
      identity: 'provisional', files: [
        { name: file.name, size: file.size, ed2k: file.ed2k,
          episodeIds: [1001] }, second] };
    const result = await prepareHandoffBatch({ ...roots, verified: provisional,
      readPacer: { afterBytes: async () => {} } });
    assert.equal(result.state, 'handoff_prepared');
    assert.deepEqual(result.files.map((item) => item.episodeIds),
      [[1001], [1002]]);
    assert.deepEqual(await readdir(roots.importRoot), []);
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

test('insufficient or unmeasurable holding space stops before creating a copy', async () =>
  withRoots(async (roots) => {
    for (const statfsImpl of [
      async () => ({ bavail: 1n, bsize: 4096n }),
      async () => { throw Error('filesystem unavailable'); },
    ]) {
      const result = await prepareHandoffBatch({ ...roots, verified, statfsImpl });
      assert.equal(result.state, 'held');
      assert.ok(['insufficient_handoff_space', 'handoff_space_unavailable']
        .includes(result.reason));
      assert.deepEqual(await readdir(roots.holdingRoot), []);
      assert.deepEqual(await readdir(roots.importRoot), []);
    }
  }));

test('a lost handoff mount stops before creating a private copy', async () =>
  withRoots(async (roots) => {
    const result = await prepareHandoffBatch({ ...roots, verified,
      verifyHandoffMounts: async () =>
        ({ state: 'held', reason: 'handoff_mount_unavailable' }) });
    assert.deepEqual(result,
      { state: 'held', reason: 'handoff_mount_unavailable' });
    assert.deepEqual(await readdir(roots.holdingRoot), []);
    assert.deepEqual(await readdir(roots.importRoot), []);
  }));

test('space preflight includes the copy bytes and retained free-space reserve', async () =>
  withRoots(async (roots) => {
    await mkdir(path.join(roots.stagingRoot, 'Show'));
    await writeFile(path.join(roots.stagingRoot, file.name), bytes);
    const exact = await prepareHandoffBatch({ ...roots, verified,
      minFreeAfterBytes: 7, statfsImpl: async () => ({ bavail: 10n, bsize: 1n }) });
    assert.equal(exact.state, 'handoff_prepared');
    assert.deepEqual(await readdir(roots.importRoot), []);
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

test('copies a bounded verified subtitle with its video, without exposing either to Import', async () =>
  withRoots(async (roots) => {
    const subtitle = Buffer.from('hello');
    const sidecar = { index: 1, name: 'Show/01.en.srt', size: subtitle.length,
      sha256: createHash('sha256').update(subtitle).digest('hex').toUpperCase() };
    await mkdir(path.join(roots.stagingRoot, 'Show'));
    await writeFile(path.join(roots.stagingRoot, file.name), bytes);
    await writeFile(path.join(roots.stagingRoot, sidecar.name), subtitle);
    const result = await prepareHandoffBatch({ ...roots,
      verified: { ...verified, subtitles: [sidecar] } });
    assert.equal(result.state, 'handoff_prepared');
    assert.deepEqual(result.subtitles, [sidecar]);
    assert.deepEqual(await readFile(path.join(result.holdingPath, sidecar.name)), subtitle);
    assert.deepEqual(await readdir(roots.importRoot), []);
  }));

test('a changed subtitle removes the whole private copy and leaves sources intact', async () =>
  withRoots(async (roots) => {
    await mkdir(path.join(roots.stagingRoot, 'Show'));
    await writeFile(path.join(roots.stagingRoot, file.name), bytes);
    await writeFile(path.join(roots.stagingRoot, 'Show/01.en.srt'), 'wrong');
    const sidecar = { index: 1, name: 'Show/01.en.srt', size: 5,
      sha256: createHash('sha256').update('hello').digest('hex').toUpperCase() };
    assert.deepEqual(await prepareHandoffBatch({ ...roots,
      verified: { ...verified, subtitles: [sidecar] } }),
    { state: 'held', reason: 'source_changed' });
    assert.deepEqual(await readdir(roots.holdingRoot), []);
    assert.deepEqual(await readdir(roots.importRoot), []);
  }));
