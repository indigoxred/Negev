import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdtemp, mkdir, writeFile, link, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { provePhysicalPlexPart } from '../src/availability/physical-plex-part.mjs';

const cleanup = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'negev-plex-part-'));
  cleanup.push(root);
  const shokoRoot = path.join(root, 'shoko');
  const plexRoot = path.join(root, 'plex');
  await Promise.all([mkdir(shokoRoot), mkdir(plexRoot)]);
  const shokoPath = path.join(shokoRoot, 'episode.mkv');
  const plexPath = path.join(plexRoot, 'episode.mkv');
  await writeFile(shokoPath, 'video');
  await writeFile(plexPath, 'video');
  return { root, shokoRoot, plexRoot, shokoPath, plexPath, expectedSize: 5 };
}

test('one physical file under two scoped paths supplies a stable join key', async (t) => {
  const input = await fixture();
  await rm(input.plexPath);
  try { await link(input.shokoPath, input.plexPath); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('hard links unavailable');
    throw error;
  }
  const result = await provePhysicalPlexPart(input);
  assert.equal(result.state, 'same_file');
  assert.match(result.storageKey, /^\d+:\d+:5$/);
});

test('same-sized different bytes or inode cannot make an episode Available', async () => {
  const input = await fixture();
  await rm(input.plexPath);
  await writeFile(input.plexPath, 'other');
  assert.deepEqual(await provePhysicalPlexPart(input),
    { state: 'held', reason: 'different_file' });
});

test('a lexical escape and a missing Plex file fail closed', async () => {
  const input = await fixture();
  await assert.rejects(provePhysicalPlexPart({ ...input, plexPath: path.join(input.root, 'outside.mkv') }),
    /Invalid scoped path/);
  await rm(input.plexPath);
  assert.deepEqual(await provePhysicalPlexPart(input),
    { state: 'held', reason: 'file_unavailable' });
});

test('a Plex symlink resolving outside the approved backing roots fails closed', async (t) => {
  const input = await fixture();
  const outside = path.join(input.root, 'outside.mkv');
  await writeFile(outside, 'video');
  await rm(input.plexPath);
  try { await symlink(outside, input.plexPath); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('symlinks unavailable');
    throw error;
  }
  assert.deepEqual(await provePhysicalPlexPart(input),
    { state: 'held', reason: 'path_outside_roots' });
});

test('a symlink into the approved Shoko backing root may identify the same file', async (t) => {
  const input = await fixture();
  await rm(input.plexPath);
  try { await symlink(input.shokoPath, input.plexPath); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('symlinks unavailable');
    throw error;
  }
  assert.equal((await provePhysicalPlexPart(input)).state, 'same_file');
});

test('a Relay link resolving through its parent Plex mount proves the same file',
  { skip: process.platform === 'win32' }, async () => {
    const input = await fixture();
    const relay = path.join(input.plexRoot, 'relay', 'show', 'season');
    await mkdir(relay, { recursive: true });
    await rm(input.plexPath);
    await link(input.shokoPath, input.plexPath);
    const plexPath = path.join(relay, 'S01E12.mkv');
    await symlink(path.relative(relay, input.plexPath), plexPath);
    assert.equal((await provePhysicalPlexPart({ ...input, plexPath })).state,
      'same_file');
  });

test('a changed expected file size cannot establish the join', async () => {
  const input = await fixture();
  assert.deepEqual(await provePhysicalPlexPart({ ...input, expectedSize: 6 }),
    { state: 'held', reason: 'size_mismatch' });
});
