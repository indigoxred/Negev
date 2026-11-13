import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { preparePureMove } from '../src/acquisition/pure-move-handoff.mjs';

async function withRoots(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-pure-move-'));
  const stagingRoot = path.join(root, '.negev-staging', 'a'.repeat(40));
  const holdingRoot = path.join(root, '.negev-handoff', 'holding');
  const importRoot = path.join(root, 'Import');
  await Promise.all([stagingRoot, holdingRoot, importRoot].map((dir) =>
    mkdir(dir, { recursive: true })));
  try { await run({ stagingRoot, holdingRoot, importRoot }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

const file = { name: 'Show/01.mkv', size: 3, episodeIds: [1001] };

test('journals before moving selected files, preserves inode and leaves Import untouched', async () =>
  withRoots(async (roots) => {
    await mkdir(path.join(roots.stagingRoot, 'Show'));
    await writeFile(path.join(roots.stagingRoot, file.name), 'abc');
    const before = await stat(path.join(roots.stagingRoot, file.name));
    const recorded = [];
    const result = await preparePureMove({ ...roots, attemptId: 7,
      torrentHash: 'a'.repeat(40), files: [file],
      recordIntent: async (intent) => {
        assert.equal((await readFile(path.join(roots.stagingRoot, file.name))).toString(), 'abc');
        recorded.push(intent);
        return { state: 'recorded' };
      },
    });
    assert.equal(result.state, 'prepared', JSON.stringify(result));
    assert.equal(recorded.length, 1);
    assert.equal((await readFile(path.join(result.holdingPath, file.name))).toString(), 'abc');
    assert.equal((await stat(path.join(result.holdingPath, file.name))).ino, before.ino);
    assert.deepEqual(await readdir(roots.importRoot), []);
    assert.deepEqual(await readdir(path.join(roots.stagingRoot, 'Show')), []);
  }));

test('failed intent leaves all source bytes in staging', async () =>
  withRoots(async (roots) => {
    await mkdir(path.join(roots.stagingRoot, 'Show'));
    await writeFile(path.join(roots.stagingRoot, file.name), 'abc');
    const result = await preparePureMove({ ...roots, attemptId: 7,
      torrentHash: 'a'.repeat(40), files: [file],
      recordIntent: async () => ({ state: 'held' }),
    });
    assert.deepEqual(result, { state: 'held', reason: 'intent_unavailable' });
    assert.equal((await readFile(path.join(roots.stagingRoot, file.name))).toString(), 'abc');
    assert.deepEqual(await readdir(roots.holdingRoot), []);
  }));

test('preserves downloader file mode across the move', { skip: process.platform === 'win32' }, async () =>
  withRoots(async (roots) => {
    await mkdir(path.join(roots.stagingRoot, 'Show'));
    await writeFile(path.join(roots.stagingRoot, file.name), 'abc');
    await chmod(path.join(roots.stagingRoot, file.name), 0o664);
    const result = await preparePureMove({ ...roots, attemptId: 7,
      torrentHash: 'a'.repeat(40), files: [file],
      recordIntent: async () => ({ state: 'recorded' }),
    });
    assert.equal(result.state, 'prepared');
    assert.equal((await stat(path.join(result.holdingPath, file.name))).mode & 0o777,
      0o664);
  }));

test('wrong size and unsafe names fail before an intent or move', async () =>
  withRoots(async (roots) => {
    await mkdir(path.join(roots.stagingRoot, 'Show'));
    await writeFile(path.join(roots.stagingRoot, file.name), 'abc');
    let called = false;
    for (const files of [[{ ...file, size: 4 }], [{ ...file, name: '../01.mkv' }]]) {
      const result = await preparePureMove({ ...roots, attemptId: 7,
        torrentHash: 'a'.repeat(40), files,
        recordIntent: async () => { called = true; return { state: 'recorded' }; },
      });
      assert.equal(result.state, 'held');
    }
    assert.equal(called, false);
    assert.equal((await readFile(path.join(roots.stagingRoot, file.name))).toString(), 'abc');
  }));

test('restart finishes an interrupted multi-file move without a copy or duplicate', async () =>
  withRoots(async (roots) => {
    await mkdir(path.join(roots.stagingRoot, 'Show'));
    await writeFile(path.join(roots.stagingRoot, file.name), 'abc');
    await writeFile(path.join(roots.stagingRoot, 'Show/02.mkv'), 'def');
    const files = [file, { name: 'Show/02.mkv', size: 3, episodeIds: [1002] }];
    let saved;
    const recordIntent = async (intent) => {
      if (saved) assert.deepEqual(intent, saved);
      else saved = intent;
      return { state: 'recorded' };
    };
    let moves = 0;
    const first = await preparePureMove({ ...roots, attemptId: 7,
      torrentHash: 'a'.repeat(40), files, recordIntent,
      renameFile: async (source, destination) => {
        if (++moves === 2) throw Object.assign(Error('interrupted'), { code: 'EIO' });
        return rename(source, destination);
      },
    });
    assert.deepEqual(first, { state: 'held', reason: 'move_outcome_unknown' });
    const second = await preparePureMove({ ...roots, attemptId: 7,
      torrentHash: 'a'.repeat(40), files, recordIntent });
    assert.equal(second.state, 'prepared');
    assert.equal((await readFile(path.join(second.holdingPath, 'Show/01.mkv'))).toString(), 'abc');
    assert.equal((await readFile(path.join(second.holdingPath, 'Show/02.mkv'))).toString(), 'def');
    assert.deepEqual(await readdir(roots.importRoot), []);
  }));

test('cross-filesystem rename fails closed and leaves the source in staging', async () =>
  withRoots(async (roots) => {
    await mkdir(path.join(roots.stagingRoot, 'Show'));
    await writeFile(path.join(roots.stagingRoot, file.name), 'abc');
    const result = await preparePureMove({ ...roots, attemptId: 7,
      torrentHash: 'a'.repeat(40), files: [file],
      recordIntent: async () => ({ state: 'recorded' }),
      renameFile: async () => { throw Object.assign(Error('other filesystem'), { code: 'EXDEV' }); },
    });
    assert.deepEqual(result, { state: 'held', reason: 'cross_filesystem_move' });
    assert.equal((await readFile(path.join(roots.stagingRoot, file.name))).toString(), 'abc');
    assert.deepEqual(await readdir(roots.importRoot), []);
  }));

test('a symlinked selected source never reaches the intent', async (t) =>
  withRoots(async (roots) => {
    const outside = path.join(path.dirname(roots.stagingRoot), 'outside.mkv');
    await writeFile(outside, 'abc');
    await mkdir(path.join(roots.stagingRoot, 'Show'));
    try { await symlink(outside, path.join(roots.stagingRoot, file.name)); }
    catch (error) {
      if (error?.code === 'EPERM') return t.skip('Windows symlink privilege unavailable');
      throw error;
    }
    let called = false;
    const result = await preparePureMove({ ...roots, attemptId: 7,
      torrentHash: 'a'.repeat(40), files: [file],
      recordIntent: async () => { called = true; return { state: 'recorded' }; },
    });
    assert.equal(result.state, 'held');
    assert.equal(called, false);
  }));

test('a symlinked attempt holding directory cannot redirect a selected file', async (t) =>
  withRoots(async (roots) => {
    await mkdir(path.join(roots.stagingRoot, 'Show'));
    await writeFile(path.join(roots.stagingRoot, file.name), 'abc');
    const outside = path.join(path.dirname(roots.importRoot), 'outside');
    await mkdir(outside);
    const holdingPath = path.join(roots.holdingRoot, `negev-7-${'a'.repeat(16)}`);
    try { await symlink(outside, holdingPath, 'dir'); }
    catch (error) {
      if (error?.code === 'EPERM') return t.skip('Windows symlink privilege unavailable');
      throw error;
    }
    let recorded = false;
    const result = await preparePureMove({ ...roots, attemptId: 7,
      torrentHash: 'a'.repeat(40), files: [file],
      recordIntent: async () => { recorded = true; return { state: 'recorded' }; },
    });
    assert.equal(result.state, 'held');
    assert.equal(recorded, false);
    assert.deepEqual(await readdir(outside), []);
    assert.equal((await readFile(path.join(roots.stagingRoot, file.name))).toString(), 'abc');
  }));

test('a symlinked nested holding parent cannot redirect a selected file', async (t) =>
  withRoots(async (roots) => {
    await mkdir(path.join(roots.stagingRoot, 'Show'));
    await writeFile(path.join(roots.stagingRoot, file.name), 'abc');
    const outside = path.join(path.dirname(roots.importRoot), 'outside');
    await mkdir(outside);
    const holdingPath = path.join(roots.holdingRoot, `negev-7-${'a'.repeat(16)}`);
    await mkdir(holdingPath);
    try { await symlink(outside, path.join(holdingPath, 'Show'), 'dir'); }
    catch (error) {
      if (error?.code === 'EPERM') return t.skip('Windows symlink privilege unavailable');
      throw error;
    }
    let recorded = false;
    const result = await preparePureMove({ ...roots, attemptId: 7,
      torrentHash: 'a'.repeat(40), files: [file],
      recordIntent: async () => { recorded = true; return { state: 'recorded' }; },
    });
    assert.equal(result.state, 'held');
    assert.equal(recorded, false);
    assert.deepEqual(await readdir(outside), []);
    assert.equal((await readFile(path.join(roots.stagingRoot, file.name))).toString(), 'abc');
  }));

test('a holding parent changed after intent cannot redirect a selected file', async (t) =>
  withRoots(async (roots) => {
    await mkdir(path.join(roots.stagingRoot, 'Show'));
    await writeFile(path.join(roots.stagingRoot, file.name), 'abc');
    const outside = path.join(path.dirname(roots.importRoot), 'outside');
    await mkdir(outside);
    const holdingPath = path.join(roots.holdingRoot, `negev-7-${'a'.repeat(16)}`);
    let linked = false;
    const result = await preparePureMove({ ...roots, attemptId: 7,
      torrentHash: 'a'.repeat(40), files: [file],
      recordIntent: async () => {
        try { await symlink(outside, holdingPath, 'dir'); linked = true; }
        catch (error) {
          if (error?.code !== 'EPERM') throw error;
        }
        return { state: 'recorded' };
      },
    });
    if (!linked) return t.skip('Windows symlink privilege unavailable');
    assert.equal(result.state, 'held');
    assert.deepEqual(await readdir(outside), []);
    assert.equal((await readFile(path.join(roots.stagingRoot, file.name))).toString(), 'abc');
  }));
