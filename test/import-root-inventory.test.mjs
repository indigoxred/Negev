import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readImportRootInventory } from '../src/availability/import-root-inventory.mjs';

test('a bounded Import inventory records paths and sizes without reading file bytes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-import-inventory-'));
  try {
    await mkdir(path.join(root, 'show'));
    await writeFile(path.join(root, 'show', 'episode.mkv'), 'one');
    const result = await readImportRootInventory({ root });
    assert.equal(result.state, 'inventory');
    assert.deepEqual(result.files.map(({ relativePath, size }) => ({ relativePath, size })),
      [{ relativePath: 'show/episode.mkv', size: 3 }]);
    assert.equal(typeof result.fingerprint, 'string');
    assert.equal(result.fingerprint.length, 64);
    await writeFile(path.join(root, 'show', 'episode.mkv'), 'two-more');
    const changed = await readImportRootInventory({ root });
    assert.notEqual(changed.fingerprint, result.fingerprint);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('missing roots and over-limit inventories cannot be considered quiet', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-import-inventory-'));
  try {
    assert.deepEqual(await readImportRootInventory({ root: path.join(root, 'missing') }),
      { state: 'unavailable' });
    await writeFile(path.join(root, 'one.mkv'), 'one');
    await writeFile(path.join(root, 'two.mkv'), 'two');
    assert.deepEqual(await readImportRootInventory({ root, maxEntries: 1 }),
      { state: 'unavailable' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a transient root-level arrival changes the fingerprint after removal', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-import-inventory-'));
  try {
    const before = await readImportRootInventory({ root });
    await writeFile(path.join(root, 'transient.mkv'), 'episode');
    await rm(path.join(root, 'transient.mkv'));
    const after = await readImportRootInventory({ root });
    assert.deepEqual(after.files, before.files);
    assert.notEqual(after.fingerprint, before.fingerprint);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a symlink in Import cannot escape the bounded inventory', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-import-inventory-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'negev-import-outside-'));
  try {
    try { await symlink(outside, path.join(root, 'linked'), 'dir'); }
    catch (error) {
      if (process.platform === 'win32' && error.code === 'EPERM') {
        t.skip('Windows account cannot create symlinks');
        return;
      }
      throw error;
    }
    assert.deepEqual(await readImportRootInventory({ root }),
      { state: 'unavailable' });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
