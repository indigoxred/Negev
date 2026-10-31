import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ed2kBuffer } from '../src/identity/ed2k.mjs';
import { evaluateHandoffEvidence } from '../src/acquisition/handoff-evidence.mjs';
import { prepareHandoffBatch } from '../src/acquisition/prepare-handoff-batch.mjs';
import { publishPreparedHandoff } from '../src/acquisition/publish-handoff-batch.mjs';

async function withBatch(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-publish-'));
  const stagingRoot = path.join(root, 'staging');
  const holdingRoot = path.join(root, 'holding');
  const importRoot = path.join(root, 'import');
  try {
    await Promise.all([stagingRoot, holdingRoot, importRoot].map((dir) => mkdir(dir)));
    const video = Buffer.from('abc');
    const subtitle = Buffer.from('hello');
    await writeFile(path.join(stagingRoot, '01.mkv'), video);
    await writeFile(path.join(stagingRoot, '01.en.srt'), subtitle);
    const verified = { state: 'batch_identity_verified', handoffReady: false,
      torrentHash: 'a'.repeat(40), anidbId: 42,
      files: [{ name: '01.mkv', size: video.length, ed2k: ed2kBuffer(video),
        anidbFileId: 51, episodeIds: [1001] }],
      subtitles: [{ index: 1, name: '01.en.srt', size: subtitle.length,
        sha256: (await import('node:crypto')).createHash('sha256').update(subtitle)
          .digest('hex').toUpperCase() }] };
    const prepared = await prepareHandoffBatch({ stagingRoot, holdingRoot, importRoot, verified });
    assert.equal(prepared.state, 'handoff_prepared');
    const manifest = evaluateHandoffEvidence(prepared).manifest;
    const publishName = `negev-1-${prepared.evidenceDigest.slice(0, 16)}`;
    let status = 'prepared';
    let begins = 0;
    const ledger = {
      getHandoff: () => ({ status, holdingPath: prepared.holdingPath,
        torrentHash: prepared.torrentHash, evidenceDigest: prepared.evidenceDigest,
        manifest, publishName }),
      beginPublish: () => { begins++; status = 'publish_unknown';
        return { state: 'publish_unknown', sendNow: true, publishName }; },
    };
    const lookup = async ({ ed2k, size }) => ({ status: 200, release: {
      id: `anidb://${ed2k}+${size}`, providerName: 'AniDB',
      releaseURI: 'https://anidb.net/file/51', fileSize: size,
      hashes: [{ type: 'ED2K', value: ed2k }],
      crossReferences: [{ anidbAnimeID: 42, anidbEpisodeID: 1001 }],
    } });
    await run({ prepared, ledger, lookup, holdingRoot, importRoot,
      video, subtitle, publishName, getBegins: () => begins });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('one final exact check exposes a complete directory and leaves outcome unknown',
  { skip: process.platform === 'win32' ? 'Windows sandbox denies directory rename' : false },
  async () =>
  withBatch(async (sample) => {
    const result = await publishPreparedHandoff({ ...sample, attemptId: 1, nowMs: 500 });
    assert.equal(result.state, 'publish_unknown', JSON.stringify({ result,
      begins: sample.getBegins(), entries: await readdir(sample.importRoot) }));
    assert.equal(sample.getBegins(), 1);
    assert.deepEqual(await readdir(sample.importRoot), [sample.publishName]);
    assert.deepEqual(await readFile(path.join(sample.importRoot, sample.publishName, '01.mkv')),
      sample.video);
    assert.deepEqual(await readFile(path.join(sample.importRoot, sample.publishName, '01.en.srt')),
      sample.subtitle);
    assert.deepEqual(await readdir(sample.holdingRoot), []);
    assert.deepEqual(await publishPreparedHandoff({ ...sample, attemptId: 1, nowMs: 501 }),
      { state: 'held', reason: 'publish_outcome_unknown' });
    assert.equal(sample.getBegins(), 1);
  }));

test('an unexpected file in private holding prevents intent and watched-folder exposure', async () =>
  withBatch(async (sample) => {
    await writeFile(path.join(sample.prepared.holdingPath, 'extra.sh'), 'bad');
    assert.deepEqual(await publishPreparedHandoff({ ...sample, attemptId: 1, nowMs: 500 }),
      { state: 'held', reason: 'manifest_tree_mismatch' });
    assert.equal(sample.getBegins(), 0);
    assert.deepEqual(await readdir(sample.importRoot), []);
  }));

test('a watched root overlapping private holding cannot publish', async () =>
  withBatch(async (sample) => {
    assert.deepEqual(await publishPreparedHandoff({ ...sample,
      importRoot: sample.holdingRoot, attemptId: 1, nowMs: 500 }),
    { state: 'held', reason: 'unsafe_handoff_roots' });
    assert.equal(sample.getBegins(), 0);
    assert.deepEqual(await readdir(sample.importRoot), []);
  }));
