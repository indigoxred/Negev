import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readImportRootState } from '../src/availability/import-root-state.mjs';

test('an empty Import root is only a point-in-time observation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-import-root-'));
  try {
    assert.deepEqual(await readImportRootState({ root }), { state: 'empty_observed' });
    await mkdir(path.join(root, 'finished-empty'));
    assert.deepEqual(await readImportRootState({ root }), { state: 'empty_observed' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a file is busy before Shoko has queued or hashed it', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-import-root-'));
  try {
    await mkdir(path.join(root, 'incoming'));
    await writeFile(path.join(root, 'incoming', 'episode.mkv'), 'synthetic');
    assert.deepEqual(await readImportRootState({ root }), { state: 'busy' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('missing roots, invalid roots, and bounded depth never report empty', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-import-root-'));
  try {
    assert.deepEqual(await readImportRootState({ root: path.join(root, 'missing') }),
      { state: 'unavailable' });
    await assert.rejects(() => readImportRootState({ root: 'relative' }), TypeError);
    await mkdir(path.join(root, 'a'));
    await mkdir(path.join(root, 'a', 'b'));
    assert.deepEqual(await readImportRootState({ root, maxDepth: 1 }),
      { state: 'unavailable' });
    assert.deepEqual(await readImportRootState({ root, maxEntries: 1 }),
      { state: 'unavailable' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
