import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { preparePureMove } from '../src/acquisition/pure-move-handoff.mjs';
import { publishPureMove } from '../src/acquisition/publish-pure-move.mjs';

async function withPrepared(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-pure-publish-'));
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
