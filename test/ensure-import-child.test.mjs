import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ensureImportChild } from '../src/acquisition/ensure-import-child.mjs';

test('recreates only the empty Negev child when its watched parent is mounted', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-import-child-'));
  const holdingRoot = path.join(root, 'holding');
  const importRoot = path.join(root, 'Import', 'Negev');
  await mkdir(holdingRoot);
  await mkdir(path.dirname(importRoot));
  try {
    const checks = [];
    const verify = async (input) => {
      checks.push(input.importRoot);
      return { state: 'mounted_handoff_roots' };
    };
    assert.deepEqual(await ensureImportChild({ importRoot, holdingRoot,
      verifyHandoffMounts: verify }), { state: 'import_child_ready' });
    assert.equal((await lstat(importRoot)).isDirectory(), true);
    assert.deepEqual(checks, [path.dirname(importRoot), importRoot]);
    assert.deepEqual(await ensureImportChild({ importRoot, holdingRoot,
      verifyHandoffMounts: verify }), { state: 'import_child_ready' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('holds on an unproved parent, wrong child name or symlink', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-import-child-'));
  const holdingRoot = path.join(root, 'holding');
  const parent = path.join(root, 'Import');
  const importRoot = path.join(parent, 'Negev');
  await mkdir(holdingRoot);
  await mkdir(parent);
  try {
    assert.deepEqual(await ensureImportChild({ importRoot, holdingRoot,
      verifyHandoffMounts: async () => ({ state: 'held' }) }),
    { state: 'held', reason: 'import_child_unavailable' });
    await assert.rejects(lstat(importRoot), { code: 'ENOENT' });
    assert.deepEqual(await ensureImportChild({ importRoot: parent,
      holdingRoot, verifyHandoffMounts: async () =>
        ({ state: 'mounted_handoff_roots' }) }),
    { state: 'held', reason: 'import_child_unavailable' });
    try { await symlink(holdingRoot, importRoot, 'dir'); }
    catch { t.diagnostic('Symlink unavailable on this Windows account'); return; }
    assert.deepEqual(await ensureImportChild({ importRoot, holdingRoot,
      verifyHandoffMounts: async () => ({ state: 'mounted_handoff_roots' }) }),
    { state: 'held', reason: 'import_child_unavailable' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('holds an unexpected occupant but accepts a Negev publication directory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-import-child-'));
  const holdingRoot = path.join(root, 'holding');
  const importRoot = path.join(root, 'Import', 'Negev');
  await mkdir(holdingRoot);
  await mkdir(path.dirname(importRoot));
  await mkdir(importRoot);
  const input = { holdingRoot, importRoot,
    verifyHandoffMounts: async () => ({ state: 'mounted_handoff_roots' }) };
  try {
    await writeFile(path.join(importRoot, 'unknown.txt'), 'not Negev');
    assert.deepEqual(await ensureImportChild(input),
      { state: 'held', reason: 'import_child_unavailable' });
    await rm(path.join(importRoot, 'unknown.txt'));
    await mkdir(path.join(importRoot, `negev-1-${'a'.repeat(16)}`));
    assert.deepEqual(await ensureImportChild(input),
      { state: 'import_child_ready' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
