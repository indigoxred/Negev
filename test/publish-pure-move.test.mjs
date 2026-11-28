import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { preparePureMove } from '../src/acquisition/pure-move-handoff.mjs';
import { publishPureMove } from '../src/acquisition/publish-pure-move.mjs';
import { processPurePublish } from '../src/acquisition/process-pure-publish.mjs';

async function withPrepared(run) {
  // Match the canonical roots journalled by preparePureMove, including Windows
  // temporary-directory aliases whose spelling differs from realpath.
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'negev-pure-publish-')));
  const hash = 'a'.repeat(40);
  const stagingRoot = path.join(root, '.negev-staging', hash);
  const holdingRoot = path.join(root, '.negev-handoff', 'holding');
  const importRoot = path.join(root, 'Import');
  await Promise.all([stagingRoot, holdingRoot, importRoot].map((dir) =>
    mkdir(dir, { recursive: true })));
  await mkdir(path.join(stagingRoot, 'Show'));
  await writeFile(path.join(stagingRoot, 'Show/01.mkv'), 'abc');
  const prepared = await preparePureMove({ attemptId: 7, torrentHash: hash,
    stagingRoot, holdingRoot, importRoot,
    files: [{ name: 'Show/01.mkv', size: 3, episodeIds: [1001] }],
    recordIntent: async () => ({ state: 'recorded' }) });
  assert.equal(prepared.state, 'prepared');
  const row = { status: 'prepared', manifest: { attemptId: 7, torrentHash: hash,
    stagingRoot, holdingPath: prepared.holdingPath, files: prepared.files } };
  const ledger = {
    getIntent() { return row; },
    beginPublish() {
      if (row.status !== 'prepared') return { state: 'publish_unknown', sendNow: false };
      row.status = 'publish_unknown';
      return { state: 'publish_unknown', sendNow: true };
    },
    markPublished() { row.status = 'published_observed';
      return { state: 'published_observed' }; },
  };
  try { await run({ prepared, ledger, holdingRoot, importRoot, row }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('publishes a complete checked tree by one directory rename', async () =>
  withPrepared(async ({ ledger, holdingRoot, importRoot }) => {
    const before = await stat(path.join(holdingRoot, 'negev-7-aaaaaaaaaaaaaaaa', 'Show/01.mkv'));
    const result = await publishPureMove({ attemptId: 7, ledger, holdingRoot,
      importRoot, nowMs: 100 });
    assert.equal(result.state, 'published_observed');
    const dest = path.join(importRoot, 'negev-7-aaaaaaaaaaaaaaaa', 'Show/01.mkv');
    assert.equal((await readFile(dest)).toString(), 'abc');
    assert.equal((await stat(dest)).ino, before.ino);
    if (process.platform !== 'win32') {
      assert.equal((await stat(path.dirname(dest))).mode & 0o111, 0o111);
    }
  }));

test('crash after rename reconciles the exact destination without a second rename', async () =>
  withPrepared(async ({ ledger, holdingRoot, importRoot, row }) => {
    let renamed = false;
    const first = await publishPureMove({ attemptId: 7, ledger, holdingRoot,
      importRoot, nowMs: 100,
      renamePrepared: async (source, destination) => {
        await rename(source, destination);
        renamed = true;
        throw Error('interrupted after rename');
      } });
    assert.equal(renamed, true);
    assert.deepEqual(first, { state: 'held', reason: 'publish_outcome_unknown' });
    assert.equal(row.status, 'publish_unknown');
    const second = await publishPureMove({ attemptId: 7, ledger, holdingRoot,
      importRoot, nowMs: 101 });
    assert.equal(second.state, 'published_observed');
    assert.equal(row.status, 'published_observed');
  }));

test('changed private bytes stop before watched import', async () =>
  withPrepared(async ({ ledger, holdingRoot, importRoot }) => {
    await writeFile(path.join(holdingRoot, 'negev-7-aaaaaaaaaaaaaaaa', 'Show/01.mkv'), 'xyz');
    const result = await publishPureMove({ attemptId: 7, ledger, holdingRoot,
      importRoot, nowMs: 100 });
    assert.deepEqual(result, { state: 'held', reason: 'manifest_changed' });
  }));

test('a Shoko-consumed destination after a failed journal write is uncertain, not changed',
  async () => withPrepared(async ({ ledger, holdingRoot, importRoot, row }) => {
    ledger.markPublished = () => { throw Error('journal unavailable'); };
    assert.deepEqual(await publishPureMove({ attemptId: 7, ledger,
      holdingRoot, importRoot, nowMs: 100 }),
    { state: 'held', reason: 'publish_outcome_unknown' });
    await rename(path.join(importRoot, 'negev-7-aaaaaaaaaaaaaaaa'),
      path.join(importRoot, 'Shoko-consumed'));
    assert.deepEqual(await publishPureMove({ attemptId: 7, ledger,
      holdingRoot, importRoot, nowMs: 101 }),
    { state: 'held', reason: 'published_tree_absent' });
    assert.equal(row.status, 'publish_unknown');
  }));

test('consumed unknown move records the exact Shoko file without rereading video',
  async () => withPrepared(async ({ ledger, holdingRoot, importRoot, row }) => {
    ledger.markPublished = () => { throw Error('journal unavailable'); };
    const first = await publishPureMove({ attemptId: 7, ledger,
      holdingRoot, importRoot, nowMs: 100 });
    assert.deepEqual(first, { state: 'held', reason: 'publish_outcome_unknown' });
    const shokoRoot = path.join(path.dirname(importRoot), 'Shoko');
    await mkdir(shokoRoot);
    await rename(path.join(importRoot, 'negev-7-aaaaaaaaaaaaaaaa'),
      path.join(shokoRoot, 'Consumed'));
    let recorded;
    ledger.recordContentPresent = (input) => { recorded = input;
      return { state: 'content_present', publicationProven: false }; };
    const result = await processPurePublish({ attemptId: 7, pureMoves: ledger,
      nowMs: 101, stagingHostPath: path.dirname(row.manifest.stagingRoot),
      holdingRoot, importRoot, target: { anidbId: 42, episodeIds: [1001] },
      shokoMount: { appRoot: '/pure', localRoot: shokoRoot },
      readEpisode: async () => ({ state: 'ok', complete: true, files: [{
        fileId: 77, anidbId: 42, episodeIds: [1001], size: 3,
        coverage: [{ episodeId: 1001, start: 0, end: 100 }],
        releaseEvidence: 'registered',
        sourcePaths: ['/pure/Consumed/Show/01.mkv'],
      }] }) });
    assert.deepEqual(result, { state: 'held', reason: 'content_present_unattributed' });
    assert.deepEqual(recorded.files, [{ name: 'Show/01.mkv', fileId: 77,
      releaseEvidence: 'registered' }]);
    assert.equal(row.status, 'publish_unknown');
    assert.equal((await readFile(path.join(shokoRoot, 'Consumed/Show/01.mkv'))).toString(),
      'abc');
  }));
