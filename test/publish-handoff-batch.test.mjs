import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ED2K_CHUNK_SIZE, ed2kBuffer } from '../src/identity/ed2k.mjs';
import { evaluateHandoffEvidence } from '../src/acquisition/handoff-evidence.mjs';
import { prepareHandoffBatch } from '../src/acquisition/prepare-handoff-batch.mjs';
import { publishPreparedHandoff } from '../src/acquisition/publish-handoff-batch.mjs';
import { restorePreparedHandoff } from '../src/acquisition/restore-prepared-handoff.mjs';
import { processRecordedHandoff } from '../src/acquisition/process-recorded-handoff.mjs';

async function withBatch(run, { videoBytes = Buffer.from('abc'),
  ed2kMode, offline = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-publish-'));
  const stagingRoot = path.join(root, 'staging');
  const holdingRoot = path.join(root, 'holding');
  const importRoot = path.join(root, 'import');
  try {
    await Promise.all([stagingRoot, holdingRoot, importRoot].map((dir) => mkdir(dir)));
    const video = videoBytes;
    const subtitle = Buffer.from('hello');
    await writeFile(path.join(stagingRoot, '01.mkv'), video);
    await writeFile(path.join(stagingRoot, '01.en.srt'), subtitle);
    const verified = { state: 'batch_identity_verified', handoffReady: false,
      torrentHash: 'a'.repeat(40), anidbId: 42,
      files: [{ name: '01.mkv', size: video.length,
        ed2k: ed2kBuffer(video, { mode: ed2kMode ?? 'edonkey' }),
        ...(offline ? { identitySource: 'shoko_offline',
          releaseId: 'offline://42-1001' } : { anidbFileId: 51 }),
        episodeIds: [1001] }],
      subtitles: [{ index: 1, name: '01.en.srt', size: subtitle.length,
        sha256: (await import('node:crypto')).createHash('sha256').update(subtitle)
          .digest('hex').toUpperCase() }] };
    const prepared = await prepareHandoffBatch({ stagingRoot, holdingRoot,
      importRoot, verified, ed2kMode,
      readPacer: { afterBytes: async () => {} } });
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
    const offlineLookup = async ({ filename }) => ({ status: 200, release: {
      ProviderName: 'Offline Importer', ID: 'offline://42-1001',
      OriginalFilename: filename, IsCorrupted: false,
      CrossReferences: [{ AnidbAnimeID: 42, AnidbEpisodeID: 1001,
        PercentageStart: 0, PercentageEnd: 100 }],
    } });
    await run({ prepared, ledger, lookup, offlineLookup, holdingRoot, importRoot,
      video, subtitle, publishName, getBegins: () => begins,
      getObservations: () => observations });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('offline handoff rechecks exact preview and bytes before watched Import', async () =>
  withBatch(async (sample) => {
    const result = await publishPreparedHandoff({ ...sample,
      lookup: async () => ({ status: 204 }), attemptId: 1, nowMs: 500,
      readPacer: { afterBytes: async () => {} },
      renamePrepared: async (source, destination) => {
        await cp(source, destination, { recursive: true });
        await rm(source, { recursive: true });
      } });
    assert.equal(result.state, 'published_observed', JSON.stringify(result));
    assert.equal(sample.getBegins(), 1);
    assert.deepEqual(await readFile(path.join(sample.importRoot,
      sample.publishName, '01.mkv')), sample.video);
  }, { offline: true }));

test('offline handoff holds when preview is unavailable or changes target', async () => {
  for (const changed of ['unavailable', 'wrong_episode']) {
    await withBatch(async (sample) => {
      const result = await publishPreparedHandoff({ ...sample,
        lookup: async () => ({ status: 204 }), attemptId: 1, nowMs: 500,
        readPacer: { afterBytes: async () => {} },
        offlineLookup: async (input) => {
          if (changed === 'unavailable') return { status: 0 };
          const preview = await sample.offlineLookup(input);
          preview.release.CrossReferences[0].AnidbEpisodeID = 1002;
          return preview;
        } });
      assert.equal(result.state, 'held');
      assert.equal(sample.getBegins(), 0);
      assert.deepEqual(await readdir(sample.importRoot), []);
    }, { offline: true });
  }
});

test('offline handoff rechecks an intervening Shoko import before the watched rename', async () =>
  withBatch(async (sample) => {
    let checked = false;
    const result = await publishPreparedHandoff({ ...sample,
      lookup: async () => ({ status: 204 }), attemptId: 1, nowMs: 500,
      checkExisting: async (verified) => {
        checked = true;
        assert.equal(verified.anidbId, 42);
        assert.equal(verified.files[0].releaseId, 'offline://42-1001');
        return { state: 'held', reason: 'already_imported' };
      } });
    assert.equal(checked, true);
    assert.deepEqual(result, { state: 'held', reason: 'already_imported' });
    assert.equal(sample.getBegins(), 0);
    assert.deepEqual(await readdir(sample.importRoot), []);
    assert.deepEqual(await readFile(path.join(sample.prepared.holdingPath,
      '01.mkv')), sample.video);
  }, { offline: true }));

test('offline handoff holds a changed private video before publishing', async () =>
  withBatch(async (sample) => {
    await writeFile(path.join(sample.prepared.holdingPath, '01.mkv'),
      Buffer.from('xyz'));
    const result = await publishPreparedHandoff({ ...sample,
      lookup: async () => ({ status: 204 }), attemptId: 1, nowMs: 500 });
    assert.equal(result.state, 'held');
    assert.equal(sample.getBegins(), 0);
    assert.deepEqual(await readdir(sample.importRoot), []);
  }, { offline: true }));

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

test('provider outage during final identity check is a bounded retryable hold', async () =>
  withBatch(async (sample) => {
    const result = await publishPreparedHandoff({ ...sample,
      lookup: async () => { throw new Error('provider offline'); },
      attemptId: 1, nowMs: 500 });
    assert.deepEqual(result, { state: 'held', reason: 'identity_unavailable' });
    assert.equal(sample.getBegins(), 0);
    assert.deepEqual(await readdir(sample.importRoot), []);
  }));

test('final pre-import file check receives the selected Shoko hash mode', async () =>
  withBatch(async (sample) => {
    let observedMode;
    const result = await publishPreparedHandoff({ ...sample,
      attemptId: 1, nowMs: 500, ed2kMode: 'emule',
      verifyVideo: async (input) => {
        observedMode = input.ed2kMode;
        return { state: 'held', reason: 'provider_unavailable' };
      } });
    assert.equal(observedMode, 'emule');
    assert.equal(result.state, 'held');
    assert.equal(sample.getBegins(), 0);
    assert.deepEqual(await readdir(sample.importRoot), []);
  }));

test('a Shoko hash-mode change after preparation holds before watched Import', async () =>
  withBatch(async (sample) => {
    const result = await publishPreparedHandoff({ ...sample,
      attemptId: 1, nowMs: 500, ed2kMode: 'edonkey',
      readPacer: { afterBytes: async () => {} } });
    assert.deepEqual(result, { state: 'held', reason: 'identity_changed' });
    assert.equal(sample.getBegins(), 0);
    assert.deepEqual(await readdir(sample.importRoot), []);
  }, { videoBytes: Buffer.alloc(ED2K_CHUNK_SIZE), ed2kMode: 'emule' }));

test('the same native mode permits exact boundary proof before watched rename', async () =>
  withBatch(async (sample) => {
    const result = await publishPreparedHandoff({ ...sample,
      attemptId: 1, nowMs: 500, ed2kMode: 'emule',
      readPacer: { afterBytes: async () => {} },
      renamePrepared: async (source, destination) => {
        await cp(source, destination, { recursive: true });
        await rm(source, { recursive: true });
      } });
    assert.equal(result.state, 'published_observed', JSON.stringify(result));
    assert.equal(sample.getBegins(), 1);
    assert.equal(sample.getObservations(), 1);
  }, { videoBytes: Buffer.alloc(ED2K_CHUNK_SIZE), ed2kMode: 'emule' }));

test('a lost handoff mount stops before publish intent and watched rename', async () =>
  withBatch(async (sample) => {
    const result = await publishPreparedHandoff({ ...sample,
      attemptId: 1, nowMs: 500,
      verifyHandoffMounts: async () =>
        ({ state: 'held', reason: 'handoff_mount_unavailable' }) });
    assert.deepEqual(result,
      { state: 'held', reason: 'handoff_mount_unavailable' });
    assert.equal(sample.getBegins(), 0);
    assert.deepEqual(await readdir(sample.importRoot), []);
  }));

test('a mount lost during final verification stops before publish intent', async () =>
  withBatch(async (sample) => {
    let checks = 0;
    const result = await publishPreparedHandoff({ ...sample,
      attemptId: 1, nowMs: 500,
      verifyHandoffMounts: async () => ++checks === 1
        ? { state: 'mounted_handoff_roots' }
        : { state: 'held', reason: 'handoff_mount_unavailable' } });
    assert.deepEqual(result,
      { state: 'held', reason: 'handoff_mount_unavailable' });
    assert.equal(checks, 2);
    assert.equal(sample.getBegins(), 0);
    assert.deepEqual(await readdir(sample.importRoot), []);
  }));

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

test('offline publish-unknown recovery requires the same file and Shoko prediction', async () =>
  withBatch(async (sample) => {
    sample.ledger.beginPublish();
    const destination = path.join(sample.importRoot, sample.publishName);
    await mkdir(destination);
    await writeFile(path.join(destination, '01.mkv'), sample.video);
    await writeFile(path.join(destination, '01.en.srt'), sample.subtitle);
    await rm(sample.prepared.holdingPath, { recursive: true });
    const unchanged = await publishPreparedHandoff({ ...sample,
      lookup: async () => ({ status: 204 }), attemptId: 1, nowMs: 500 });
    assert.deepEqual(unchanged, { state: 'published_observed', destination });
    assert.equal(sample.getObservations(), 1);
  }, { offline: true }));

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

test('a successful same-process handoff records exposure before Shoko can move it', async () =>
  withBatch(async (sample) => {
    const result = await publishPreparedHandoff({ ...sample,
      renamePrepared: async (source, destination) => {
        await cp(source, destination, { recursive: true });
        await rm(source, { recursive: true });
      },
      attemptId: 1, nowMs: 500 });
    assert.deepEqual(result, { state: 'published_observed',
      destination: path.join(sample.importRoot, sample.publishName) });
    assert.equal(sample.getBegins(), 1);
    assert.equal(sample.getObservations(), 1);
    assert.deepEqual(await readdir(sample.holdingRoot), []);
  }));

test('one final exact check exposes a complete directory and records it before returning',
  { skip: process.platform === 'win32' ? 'Windows sandbox denies directory rename' : false },
  async () =>
  withBatch(async (sample) => {
    const restored = restorePreparedHandoff({ attemptId: 1,
      handoff: structuredClone(sample.ledger.getHandoff()) });
    assert.equal(restored.state, 'handoff_prepared');
    const result = await processRecordedHandoff({ ...sample,
      attemptId: 1, nowMs: 500 });
    assert.equal(result.state, 'published_observed', JSON.stringify({ result,
      begins: sample.getBegins(), entries: await readdir(sample.importRoot) }));
    assert.equal(sample.getBegins(), 1);
    assert.deepEqual(await readdir(sample.importRoot), [sample.publishName]);
    assert.deepEqual(await readFile(path.join(sample.importRoot, sample.publishName, '01.mkv')),
      sample.video);
    assert.deepEqual(await readFile(path.join(sample.importRoot, sample.publishName, '01.en.srt')),
      sample.subtitle);
    assert.equal((await stat(path.join(sample.importRoot, sample.publishName,
      '01.mkv'))).mode & 0o777, 0o644);
    assert.equal((await stat(path.join(sample.importRoot, sample.publishName,
      '01.en.srt'))).mode & 0o777, 0o644);
    assert.deepEqual(await readdir(sample.holdingRoot), []);
    assert.equal(sample.getObservations(), 1);
    assert.deepEqual(await processRecordedHandoff({ ...sample,
      attemptId: 1, nowMs: 501 }),
      { state: 'published_observed' });
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

test('recorded publisher holds before provider work when its journal is missing', async () =>
  withBatch(async (sample) => {
    const result = await processRecordedHandoff({ ...sample,
      ledger: { getHandoff: () => null }, attemptId: 1, nowMs: 500 });
    assert.deepEqual(result, { state: 'held', reason: 'handoff_missing' });
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
