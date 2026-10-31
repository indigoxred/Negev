import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ed2kBuffer } from '../src/identity/ed2k.mjs';
import { verifyStagedBatch } from '../src/acquisition/verify-staged-batch.mjs';
import { prepareHandoffBatch } from '../src/acquisition/prepare-handoff-batch.mjs';

test('a complete video and subtitle pass exact identity into private holding only', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-sidecar-batch-'));
  const stagingRoot = path.join(root, 'staging');
  const holdingRoot = path.join(root, 'holding');
  const importRoot = path.join(root, 'import');
  try {
    await Promise.all([stagingRoot, holdingRoot, importRoot].map((dir) => mkdir(dir)));
    const video = Buffer.from('exact registered video');
    const subtitle = Buffer.from('1\n00:00:00,000 --> 00:00:01,000\nHello\n');
    await writeFile(path.join(stagingRoot, '01.mkv'), video);
    await writeFile(path.join(stagingRoot, '01.en.srt'), subtitle);
    const digest = ed2kBuffer(video);
    const videoFile = { index: 0, name: '01.mkv', size: video.length };
    const sidecar = { index: 1, name: '01.en.srt', size: subtitle.length };
    const verified = await verifyStagedBatch({ root: stagingRoot,
      request: { status: 'held', anidbId: 42, episodeIds: [1001] },
      expectedTorrent: { hash: 'a'.repeat(40), category: 'negev' },
      plannedFiles: [{ name: videoFile.name, episodeIds: [1001] }],
      observe: async () => ({ state: 'complete', files: [videoFile], subtitles: [sidecar] }),
      lookup: async ({ ed2k, size }) => ({ status: 200, release: {
        id: `anidb://${ed2k}+${size}`, providerName: 'AniDB',
        releaseURI: 'https://anidb.net/file/51', fileSize: size,
        hashes: [{ type: 'ED2K', value: ed2k }],
        crossReferences: [{ anidbAnimeID: 42, anidbEpisodeID: 1001 }],
      } }),
    });
    assert.equal(verified.state, 'batch_identity_verified');
    assert.equal(verified.files[0].ed2k, digest);
    assert.equal(verified.subtitles.length, 1);
    const prepared = await prepareHandoffBatch({ stagingRoot, holdingRoot, importRoot, verified });
    assert.equal(prepared.state, 'handoff_prepared');
    assert.equal(prepared.publishReady, false);
    assert.deepEqual(await readFile(path.join(prepared.holdingPath, videoFile.name)), video);
    assert.deepEqual(await readFile(path.join(prepared.holdingPath, sidecar.name)), subtitle);
    assert.deepEqual(await readdir(importRoot), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
