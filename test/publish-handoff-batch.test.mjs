import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ed2kBuffer } from '../src/identity/ed2k.mjs';
import { evaluateHandoffEvidence } from '../src/acquisition/handoff-evidence.mjs';
import { prepareHandoffBatch } from '../src/acquisition/prepare-handoff-batch.mjs';
import { publishPreparedHandoff } from '../src/acquisition/publish-handoff-batch.mjs';
import { restorePreparedHandoff } from '../src/acquisition/restore-prepared-handoff.mjs';

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
    let observations = 0;
    const ledger = {
      getHandoff: () => ({ status, holdingPath: prepared.holdingPath,
        torrentHash: prepared.torrentHash, evidenceDigest: prepared.evidenceDigest,
        manifest, publishName }),
      beginPublish: () => { begins++; status = 'publish_unknown';
        return { state: 'publish_unknown', sendNow: true, publishName }; },
      markPublishedObserved: () => { observations++; status = 'published_observed';
        return { state: 'published_observed' }; },
    };
    const lookup = async ({ ed2k, size }) => ({ status: 200, release: {
      id: `anidb://${ed2k}+${size}`, providerName: 'AniDB',
      releaseURI: 'https://anidb.net/file/51', fileSize: size, isCorrupted: false,
      hashes: [{ type: 'ED2K', value: ed2k }],
      crossReferences: [{ anidbAnimeID: 42, anidbEpisodeID: 1001,
        percentageStart: null, percentageEnd: null }],
    } });
    await run({ prepared, ledger, lookup, holdingRoot, importRoot,
      video, subtitle, publishName, getBegins: () => begins,
      getObservations: () => observations });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('fresh partial coverage or corrupted release cannot enter watched Import', async () => {
  for (const changed of ['partial', 'corrupt', 'unknown_health']) {
    await withBatch(async (sample) => {
      const lookup = async (hash) => {
        const preview = await sample.lookup(hash);
        if (changed === 'partial') {
          preview.release.crossReferences[0].percentageStart = 0;
          preview.release.crossReferences[0].percentageEnd = 50;
        } else if (changed === 'corrupt') preview.release.isCorrupted = true;
        else delete preview.release.isCorrupted;
        return preview;
      };
      const result = await publishPreparedHandoff({ ...sample, lookup,
        attemptId: 1, nowMs: 500 });
      assert.equal(result.state, 'held', changed);
      assert.equal(sample.getBegins(), 0, changed);
      assert.deepEqual(await readdir(sample.importRoot), [], changed);
    });
  }
});

test('an uncertain publish with the exact destination is observed without another rename', async () =>
  withBatch(async (sample) => {
    sample.ledger.beginPublish();
    const destination = path.join(sample.importRoot, sample.publishName);
    await mkdir(destination);
    await writeFile(path.join(destination, '01.mkv'), sample.video);
    await writeFile(path.join(destination, '01.en.srt'), sample.subtitle);
    await rm(sample.prepared.holdingPath, { recursive: true });
    const result = await publishPreparedHandoff({ ...sample, attemptId: 1, nowMs: 500 });
    assert.deepEqual(result, { state: 'published_observed', destination });
    assert.equal(sample.getBegins(), 1);
    assert.equal(sample.getObservations(), 1);
    assert.deepEqual(await publishPreparedHandoff({ ...sample, attemptId: 1, nowMs: 501 }),
      { state: 'published_observed' });
    assert.equal(sample.getObservations(), 1);
  }));

test('an altered destination or surviving holding copy remains unknown', async () => {
  for (const keepHolding of [false, true]) {
    await withBatch(async (sample) => {
      sample.ledger.beginPublish();
      const destination = path.join(sample.importRoot, sample.publishName);
      await mkdir(destination);
      await writeFile(path.join(destination, '01.mkv'),
        keepHolding ? sample.video : Buffer.from('bad'));
      await writeFile(path.join(destination, '01.en.srt'), sample.subtitle);
      if (!keepHolding) await rm(sample.prepared.holdingPath, { recursive: true });
      assert.deepEqual(await publishPreparedHandoff({ ...sample, attemptId: 1, nowMs: 500 }),
        { state: 'held', reason: 'publish_outcome_unknown' });
      assert.equal(sample.getObservations(), 0);
      assert.equal(sample.getBegins(), 1);
    });
  }
});

test('a failed durable observation stays unknown after exact bytes are checked', async () =>
  withBatch(async (sample) => {
    sample.ledger.beginPublish();
    const destination = path.join(sample.importRoot, sample.publishName);
    await mkdir(destination);
    await writeFile(path.join(destination, '01.mkv'), sample.video);
    await writeFile(path.join(destination, '01.en.srt'), sample.subtitle);
    await rm(sample.prepared.holdingPath, { recursive: true });
    sample.ledger.markPublishedObserved = () => { throw new Error('database unavailable'); };
    assert.deepEqual(await publishPreparedHandoff({ ...sample, attemptId: 1, nowMs: 500 }),
      { state: 'held', reason: 'publish_outcome_unknown' });
    assert.equal(sample.getBegins(), 1);
  }));

test('one final exact check exposes a complete directory, then observes it on retry',
  { skip: process.platform === 'win32' ? 'Windows sandbox denies directory rename' : false },
  async () =>
  withBatch(async (sample) => {
    const restored = restorePreparedHandoff({ attemptId: 1,
      handoff: structuredClone(sample.ledger.getHandoff()) });
    assert.equal(restored.state, 'handoff_prepared');
    const result = await publishPreparedHandoff({ ...sample,
      prepared: restored, attemptId: 1, nowMs: 500 });
    assert.equal(result.state, 'publish_unknown', JSON.stringify({ result,
      begins: sample.getBegins(), entries: await readdir(sample.importRoot) }));
    assert.equal(sample.getBegins(), 1);
    assert.deepEqual(await readdir(sample.importRoot), [sample.publishName]);
    assert.deepEqual(await readFile(path.join(sample.importRoot, sample.publishName, '01.mkv')),
      sample.video);
    assert.deepEqual(await readFile(path.join(sample.importRoot, sample.publishName, '01.en.srt')),
      sample.subtitle);
    assert.deepEqual(await readdir(sample.holdingRoot), []);
    assert.deepEqual(await publishPreparedHandoff({ ...sample,
      prepared: restored, attemptId: 1, nowMs: 501 }),
      { state: 'published_observed', destination: path.join(sample.importRoot, sample.publishName) });
    assert.equal(sample.getBegins(), 1);
    assert.equal(sample.getObservations(), 1);
  }));

test('restart reconstruction rejects a damaged journal before publication', async () =>
  withBatch(async (sample) => {
    const saved = structuredClone(sample.ledger.getHandoff());
    const restored = restorePreparedHandoff({ attemptId: 1, handoff: saved });
    assert.equal(restored.state, 'handoff_prepared');
    assert.equal(restored.holdingPath, sample.prepared.holdingPath);
    assert.equal(restored.evidenceDigest, sample.prepared.evidenceDigest);
    const row = structuredClone(saved);
    row.manifest.videos[0].size++;
    assert.deepEqual(restorePreparedHandoff({ attemptId: 1, handoff: row }),
      { state: 'held', reason: 'handoff_evidence_mismatch' });
    assert.deepEqual(restorePreparedHandoff({ attemptId: 2, handoff: saved }),
      { state: 'held', reason: 'handoff_evidence_mismatch' });
    assert.equal(sample.getBegins(), 0);
    assert.deepEqual(await readdir(sample.importRoot), []);
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
