import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { preparePureMove } from '../src/acquisition/pure-move-handoff.mjs';
import { torrentFileKind } from '../src/acquisition/evaluate-stopped-manifest.mjs';
import { publishPureMove } from '../src/acquisition/publish-pure-move.mjs';

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

test('filename policy rejects drive-like paths on every platform', () => {
  for (const name of ['C:/Show/01.mkv', 'C:01.mkv', '../Show/01.mkv', '/Show/01.mkv']) {
    assert.equal(torrentFileKind(name), null, name);
  }
  assert.equal(torrentFileKind('Show/Title: Episode 01.mkv'),
    process.platform === 'win32' ? null : 'video');
});

test('Linux-valid colon names survive interrupted preparation and publication unchanged',
  { skip: process.platform === 'win32' }, async () => withRoots(async roots => {
    const files = [
      { name: 'Show: Season 1/Title: 01.mkv', size: 3, episodeIds: [1001] },
      { name: 'Show: Season 1/Title: 01.en.ass', size: 3 },
    ];
    await mkdir(path.join(roots.stagingRoot, 'Show: Season 1'));
    for (const item of files) await writeFile(path.join(roots.stagingRoot, item.name), 'abc');
    const before = await stat(path.join(roots.stagingRoot, files[0].name));
    let manifest, moves = 0;
    const recordIntent = async value => { manifest = value; return { state: 'recorded' }; };
    const first = await preparePureMove({ ...roots, attemptId: 7, torrentHash: 'a'.repeat(40),
      files, recordIntent, renameFile: async (from, to) => {
        if (++moves === 2) throw Error('restart');
        return rename(from, to);
      } });
    assert.deepEqual(first, { state: 'held', reason: 'move_outcome_unknown' });
    const second = await preparePureMove({ ...roots, attemptId: 7, torrentHash: 'a'.repeat(40),
      files, recordIntent });
    assert.equal(second.state, 'prepared');
    const row = { status: 'prepared', manifest };
    const ledger = { getIntent: () => row,
      beginPublish: () => { row.status = 'publish_unknown'; return { state: 'publish_unknown' }; },
      markPublished: () => { row.status = 'published_observed'; return { state: 'published_observed' }; } };
    const result = await publishPureMove({ attemptId: 7, ledger, holdingRoot: roots.holdingRoot,
      importRoot: roots.importRoot, nowMs: 100 });
    assert.equal(result.state, 'published_observed');
    for (const item of files) assert.equal(await readFile(path.join(roots.importRoot,
      'negev-7-aaaaaaaaaaaaaaaa', item.name), 'utf8'), 'abc');
    assert.equal((await stat(path.join(roots.importRoot, 'negev-7-aaaaaaaaaaaaaaaa', files[0].name))).ino, before.ino);
    assert.equal((await publishPureMove({ attemptId: 7, ledger, holdingRoot: roots.holdingRoot,
      importRoot: roots.importRoot, nowMs: 101 })).state, 'published_observed');
  }));

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

test('a separately scoped bonus keeps its own identity through the journalled move',async()=>withRoots(async roots=>{
 const bonus={name:'Show/Extras/OVA.mkv',size:3,episodeIds:[9001],scope:'bonus',anidbId:84,kind:'ova'};
 await mkdir(path.dirname(path.join(roots.stagingRoot,bonus.name)),{recursive:true});await writeFile(path.join(roots.stagingRoot,bonus.name),'ova');
 let intent;const result=await preparePureMove({...roots,attemptId:7,torrentHash:'a'.repeat(40),files:[bonus],recordIntent:async value=>{intent=value;return{state:'recorded'}}});
 assert.equal(result.state,'prepared');assert.equal(intent.files[0].scope,'bonus');assert.equal(intent.files[0].anidbId,84);assert.equal(intent.files[0].kind,'ova');assert.deepEqual(intent.files[0].episodeIds,[9001]);
 assert.equal((await readFile(path.join(result.holdingPath,bonus.name))).toString(),'ova');
}));
test('a bonus cannot enter a move without its separate catalogue scope',async()=>withRoots(async roots=>{
 const result=await preparePureMove({...roots,attemptId:7,torrentHash:'a'.repeat(40),files:[{...file,scope:'bonus',anidbId:0,kind:'ova'}],recordIntent:async()=>({state:'recorded'})});
 assert.equal(result.reason,'invalid_move_manifest');
}));
