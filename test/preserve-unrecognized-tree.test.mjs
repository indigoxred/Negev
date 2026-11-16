import assert from 'node:assert/strict';
import { mkdir, mkdtemp, lstat, readFile, rm, writeFile } from
  'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { preserveUnrecognizedTree } from
  '../src/acquisition/preserve-unrecognized-tree.mjs';

test('moves the exact published tree once, preserving file identity and replaying after restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-recover-tree-'));
  try {
    const importRoot = path.join(root, 'Import');
    const holdingRoot = path.join(root, 'holding');
    const torrentHash = 'a'.repeat(40);
    const attemptId = 7;
    const name = `negev-${attemptId}-${torrentHash.slice(0, 16)}`;
    const source = path.join(importRoot, name);
    await mkdir(source, { recursive: true });
    await mkdir(holdingRoot);
    await writeFile(path.join(source, '01.mkv'), 'media');
    const stat = await lstat(path.join(source, '01.mkv'), { bigint: true });
    const manifest = { attemptId, torrentHash,
      holdingPath: path.join(holdingRoot, name),
      files: [{ name: '01.mkv', size: 5, episodeIds: [1001],
        dev: String(stat.dev), ino: String(stat.ino),
        mtimeNs: String(stat.mtimeNs) }] };
    let checks = 0;
    const run = () => preserveUnrecognizedTree({ manifest, importRoot,
      holdingRoot, recheck: async () => { checks++; return {
        state: 'unrecognized_confirmed', fileId: 81 }; } });
    assert.equal((await run()).state, 'preserved');
    assert.equal(await readFile(path.join(holdingRoot,
      `recovered-${name}`, '01.mkv'), 'utf8'), 'media');
    assert.equal((await run()).state, 'preserved');
    assert.equal(checks, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
