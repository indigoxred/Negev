import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyStagedBatch } from '../src/acquisition/verify-staged-batch.mjs';
import { ed2kBuffer } from '../src/identity/ed2k.mjs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const request = { id: 1, anidbId: 42, episodeIds: [1001, 1002], status: 'held' };
const expectedTorrent = { hash: 'a'.repeat(40), category: 'negev', savePath: '/staging' };
const files = [{ index: 0, name: 'Show/01.mkv', size: 3 },
  { index: 1, name: 'Show/02.mkv', size: 3 }];
const plannedFiles = [{ name: 'Show/01.mkv', episodeIds: [1001] },
  { name: 'Show/02.mkv', episodeIds: [1002] }];
const attempt = { id: 1, requestId: 1, anidbId: 42, status: 'torrent_observed',
  episodeIds: [1001, 1002], torrentHash: expectedTorrent.hash };

test('passes the selected Shoko hash mode into the exact file verifier', async () => {
  let observedMode;
  const result = await verifyStagedBatch({ root: '/staging', request,
    attempt: { ...attempt, episodeIds: [1001] }, expectedTorrent,
    plannedFiles: [plannedFiles[0]], ed2kMode: 'emule',
    observe: async () => ({ state: 'complete', files: [files[0]] }),
    verify: async ({ ed2kMode }) => {
      observedMode = ed2kMode;
      return { state: 'identity_verified', isCorrupted: false, fileId: 51,
        coverage: [{ episodeId: 1001, start: 0, end: 100 }],
        ed2k: 'B'.repeat(32), size: 3 };
    }, lookup: async () => null,
  });
  assert.equal(result.state, 'batch_identity_verified');
  assert.equal(observedMode, 'emule');
});

test('labels the torrent check after file hashing so it can use a fresh session', async () => {
  const phases = [];
  const result = await verifyStagedBatch({ root: '/staging', request,
    attempt: { ...attempt, episodeIds: [1001] }, expectedTorrent,
    plannedFiles: [plannedFiles[0]],
    observe: async ({ phase }) => {
      phases.push(phase);
      return { state: 'complete', files: [files[0]] };
    },
    verify: async () => ({ state: 'identity_verified', isCorrupted: false,
      fileId: 51, coverage: [{ episodeId: 1001, start: 0, end: 100 }],
      ed2k: 'B'.repeat(32), size: 3 }),
    lookup: async () => null,
  });
  assert.equal(result.state, 'batch_identity_verified');
  assert.deepEqual(phases, ['before_hash', 'after_hash']);
});

test('failed post-hash session renewal holds as authentication, not changed media', async () => {
  const result = await verifyStagedBatch({ root: '/staging', request,
    attempt: { ...attempt, episodeIds: [1001] }, expectedTorrent,
    plannedFiles: [plannedFiles[0]],
    observe: async ({ phase }) => phase === 'before_hash'
      ? { state: 'complete', files: [files[0]] }
      : { state: 'held', reason: 'authentication_unavailable' },
    verify: async () => ({ state: 'identity_verified', isCorrupted: false,
      fileId: 51, coverage: [{ episodeId: 1001, start: 0, end: 100 }],
      ed2k: 'B'.repeat(32), size: 3 }),
    lookup: async () => null,
  });
  assert.deepEqual(result,
    { state: 'held', reason: 'torrent_authentication_unavailable_after_hash' });
});

test('one reserved episode subset can verify without acquiring the whole request', async () => {
  const result = await verifyStagedBatch({ root: '/staging', request,
    attempt: { ...attempt, episodeIds: [1002] }, expectedTorrent,
    plannedFiles: [plannedFiles[1]],
    observe: async () => ({ state: 'complete', files: [files[1]] }),
    verify: async () => ({ state: 'identity_verified', isCorrupted: false, fileId: 52,
      coverage: [{ episodeId: 1002, start: 0, end: 100 }],
      ed2k: 'B'.repeat(32), size: 3 }),
    lookup: async () => null,
  });
  assert.equal(result.state, 'batch_identity_verified');
  assert.deepEqual(result.files[0].episodeIds, [1002]);
});

test('one explicit AniDB miss can form a provisional batch after torrent recheck', async () => {
  const phases = [];
  const result = await verifyStagedBatch({ root: '/staging', request,
    attempt: { ...attempt, episodeIds: [1001] }, expectedTorrent,
    plannedFiles: [plannedFiles[0]], allowProvisional: true,
    observe: async ({ phase }) => { phases.push(phase);
      return { state: 'complete', files: [files[0]] }; },
    verify: async ({ allowProvisional }) => {
      assert.equal(allowProvisional, true);
      return { state: 'hash_verified', reason: 'lookup_inconclusive',
        ed2k: 'B'.repeat(32), size: 3 };
    }, lookup: async () => null,
  });
  assert.equal(result.state, 'batch_provisional');
  assert.equal(result.identity, 'provisional');
  assert.deepEqual(result.files, [{ name: files[0].name, size: 3,
    ed2k: 'B'.repeat(32), episodeIds: [1001] }]);
  assert.deepEqual(phases, ['before_hash', 'after_hash']);
});

test('two inconclusive files retain their distinct planned episode identities', async () => {
  const result = await verifyStagedBatch({ root: '/staging', request, attempt,
    expectedTorrent, plannedFiles, allowProvisional: true,
    observe: async () => ({ state: 'complete', files }),
    verify: async () => ({ state: 'hash_verified', reason: 'lookup_inconclusive',
      ed2k: 'B'.repeat(32), size: 3 }), lookup: async () => null });
  assert.equal(result.state, 'batch_provisional');
  assert.deepEqual(result.files.map((file) => file.episodeIds), [[1001], [1002]]);
});

test('mixed registered and inconclusive files retain one provisional batch', async () => {
  const result = await verifyStagedBatch({ root: '/staging', request, attempt,
    expectedTorrent, plannedFiles, allowProvisional: true,
    observe: async () => ({ state: 'complete', files }),
    verify: async ({ relativePath }) => relativePath.endsWith('01.mkv')
      ? { state: 'identity_verified', isCorrupted: false, fileId: 51,
        coverage: [{ episodeId: 1001, start: 0, end: 100 }],
        ed2k: 'B'.repeat(32), size: 3 }
      : { state: 'hash_verified', reason: 'lookup_inconclusive',
        ed2k: 'C'.repeat(32), size: 3 }, lookup: async () => null });
  assert.equal(result.state, 'batch_provisional');
  assert.deepEqual(result.files.map((file) => file.episodeIds), [[1001], [1002]]);
  assert.ok(result.files.every((file) => !Object.hasOwn(file, 'anidbFileId')));
});

test('one two-episode video requires exact full AniDB coverage for both targets', async () => {
  const pairedFiles = [{ index: 0, name: 'Show/01-02.mkv', size: 3 }];
  const pairedPlan = [{ name: pairedFiles[0].name, episodeIds: [1001, 1002] }];
  const options = { root: '/staging', request, attempt, expectedTorrent,
    plannedFiles: pairedPlan,
    observe: async () => ({ state: 'complete', files: pairedFiles }),
    lookup: async () => null };
  const verified = await verifyStagedBatch({ ...options,
    verify: async () => ({ state: 'identity_verified', isCorrupted: false, fileId: 51,
      ed2k: 'B'.repeat(32), size: 3,
      coverage: [1001, 1002].map((episodeId) =>
        ({ episodeId, start: 0, end: 100 })) }),
  });
  assert.equal(verified.state, 'batch_identity_verified');
  assert.deepEqual(verified.files[0].episodeIds, [1001, 1002]);
  const partial = await verifyStagedBatch({ ...options,
    verify: async () => ({ state: 'identity_verified', isCorrupted: false, fileId: 51,
      ed2k: 'B'.repeat(32), size: 3,
      coverage: [{ episodeId: 1001, start: 0, end: 50 },
        { episodeId: 1002, start: 50, end: 100 }] }),
  });
  assert.deepEqual(partial, { state: 'held', reason: 'partial_or_unproved_episode' });
});

test('a two-episode video with inconclusive AniDB lookup stays provisional for Shoko', async () => {
  const combined = [{ index: 0, name: 'Show/01-02.mkv', size: 3 }];
  const result = await verifyStagedBatch({ root: '/staging', request, attempt,
    expectedTorrent, plannedFiles: [{ name: combined[0].name,
      episodeIds: [1001, 1002] }], allowProvisional: true,
    observe: async () => ({ state: 'complete', files: combined }),
    verify: async () => ({ state: 'hash_verified', reason: 'lookup_inconclusive',
      ed2k: 'B'.repeat(32), size: 3 }), lookup: async () => null });
  assert.equal(result.state, 'batch_provisional');
  assert.deepEqual(result.files[0].episodeIds, [1001, 1002]);
});

test('one release in a 501-episode installment verifies only its claimed target', async () => {
  const largeRequest = { ...request,
    episodeIds: Array.from({ length: 501 }, (_, index) => 2000 + index) };
  const result = await verifyStagedBatch({ root: '/staging', request: largeRequest,
    attempt: { ...attempt, episodeIds: [2500] }, expectedTorrent,
    plannedFiles: [{ name: 'Show/01.mkv', episodeIds: [2500] }],
    observe: async () => ({ state: 'complete', files: [files[0]] }),
    verify: async () => ({ state: 'identity_verified', isCorrupted: false, fileId: 800,
      coverage: [{ episodeId: 2500, start: 0, end: 100 }],
      ed2k: 'B'.repeat(32), size: 3 }),
    lookup: async () => null,
  });
  assert.equal(result.state, 'batch_identity_verified');
  assert.deepEqual(result.files[0].episodeIds, [2500]);
});

test('unclaimed targets and mismatched attempt identity hold before observing bytes', async () => {
  for (const change of [
    { attempt: { ...attempt, requestId: 2 } },
    { attempt: { ...attempt, torrentHash: 'b'.repeat(40) } },
    { attempt: { ...attempt, episodeIds: [1003] } },
    { attempt: { ...attempt, episodeIds: [1001] }, plannedFiles: [plannedFiles[1]] },
    { plannedFiles: [{ ...plannedFiles[0], episodeIds: [1001, 1001] },
      plannedFiles[1]] },
  ]) {
    let observations = 0;
    const result = await verifyStagedBatch({ root: '/staging', request, attempt,
      expectedTorrent, plannedFiles, ...change,
      observe: async () => { observations++; return { state: 'complete', files }; },
      lookup: async () => null });
    assert.equal(result.state, 'held');
    assert.equal(observations, 0);
  }
});

test('checks each selected file in sequence and rechecks torrent before reporting evidence', async () => {
  const calls = [];
  const readPacer = { afterBytes: async () => {} };
  const result = await verifyStagedBatch({ root: '/staging', request, attempt, expectedTorrent, plannedFiles,
    readPacer,
    observe: async () => { calls.push('observe'); return { state: 'complete', files }; },
    verify: async ({ relativePath, expected, readPacer: suppliedPacer }) => {
      calls.push(relativePath);
      assert.equal(suppliedPacer, readPacer);
      assert.equal(expected.animeId, 42);
      return { state: 'identity_verified', isCorrupted: false,
        fileId: relativePath.includes('01') ? 51 : 52,
        coverage: [{ episodeId: relativePath.includes('01') ? 1001 : 1002, start: 0, end: 100 }],
        ed2k: 'B'.repeat(32), size: 3 };
    },
    lookup: async () => { throw Error('mock verify must handle lookup'); },
  });
  assert.deepEqual(calls, ['observe', 'Show/01.mkv', 'Show/02.mkv', 'observe']);
  assert.equal(result.state, 'batch_identity_verified');
  assert.equal(result.handoffReady, false);
  assert.equal(result.torrentHash, expectedTorrent.hash);
  assert.deepEqual(result.files.map((file) => file.anidbFileId), [51, 52]);
});

test('one wrong or unavailable file holds the whole batch and stops later hashing', async () => {
  const calls = [];
  const result = await verifyStagedBatch({ root: '/staging', request, attempt, expectedTorrent, plannedFiles,
    observe: async () => ({ state: 'complete', files }),
    verify: async ({ relativePath }) => {
      calls.push(relativePath);
      return { state: 'rejected', reason: 'wrong_identity' };
    }, lookup: async () => null,
  });
  assert.deepEqual(result, { state: 'held', reason: 'file_wrong_identity' });
  assert.deepEqual(calls, ['Show/01.mkv']);
});

test('an unknown corruption flag cannot produce verified batch evidence', async () => {
  const result = await verifyStagedBatch({ root: '/staging', request,
    attempt: { ...attempt, episodeIds: [1001] }, expectedTorrent,
    plannedFiles: [plannedFiles[0]],
    observe: async () => ({ state: 'complete', files: [files[0]] }),
    verify: async () => ({ state: 'identity_verified', fileId: 51,
      coverage: [{ episodeId: 1001, start: 0, end: 100 }],
      ed2k: 'B'.repeat(32), size: 3 }),
    lookup: async () => null,
  });
  assert.deepEqual(result, { state: 'held', reason: 'file_corruption_unverified' });
});

test('registered partial episode cannot reach handoff', async () => {
  const result = await verifyStagedBatch({ root: '/staging', request, attempt, expectedTorrent, plannedFiles,
    observe: async () => ({ state: 'complete', files }),
    verify: async ({ relativePath }) => ({ state: 'identity_verified', isCorrupted: false,
      fileId: relativePath.includes('01') ? 51 : 52, ed2k: 'B'.repeat(32), size: 3,
      coverage: [{ episodeId: relativePath.includes('01') ? 1001 : 1002,
        start: 0, end: relativePath.includes('01') ? 50 : 100 }] }),
    lookup: async () => null,
  });
  assert.deepEqual(result, { state: 'held', reason: 'partial_or_unproved_episode' });
});

test('manifest mismatch, duplicate targets and byte budget stop before hashing', async () => {
  for (const change of [
    { plannedFiles: [plannedFiles[0]] },
    { plannedFiles: [{ ...plannedFiles[0], episodeIds: [1001, 1002] }, plannedFiles[1]] },
    { maxTotalBytes: 5 },
  ]) {
    let hashes = 0;
    const result = await verifyStagedBatch({ root: '/staging', request, attempt, expectedTorrent,
      plannedFiles, observe: async () => ({ state: 'complete', files }),
      verify: async () => { hashes++; throw Error('must not hash'); }, lookup: async () => null,
      ...change });
    assert.equal(result.state, 'held');
    assert.equal(hashes, 0);
  }
});

test('a changed torrent after hashing cannot pass the batch', async () => {
  let observations = 0;
  const result = await verifyStagedBatch({ root: '/staging', request, attempt, expectedTorrent, plannedFiles,
    observe: async () => ({ state: 'complete', files: ++observations === 1 ? files :
      [{ ...files[0], size: 4 }, files[1]] }),
    verify: async ({ relativePath }) => ({ state: 'identity_verified', isCorrupted: false,
      coverage: [{ episodeId: relativePath.includes('01') ? 1001 : 1002, start: 0, end: 100 }],
      fileId: relativePath.includes('01') ? 51 : 52, ed2k: 'B'.repeat(32), size: 3 }),
    lookup: async () => null,
  });
  assert.deepEqual(result, { state: 'held', reason: 'torrent_changed_after_hash' });
});

test('a lost qBittorrent read after hashing is distinct from changed file evidence', async () => {
  for (const [finalObservation, reason] of [
    [{ state: 'held', reason: 'provider_unavailable' }, 'torrent_provider_unavailable_after_hash'],
    [{ state: 'held', reason: 'provider_http_403' }, 'torrent_provider_http_403_after_hash'],
    [{ state: 'held', reason: 'provider_timeout' }, 'torrent_provider_timeout_after_hash'],
    [{ state: 'held', reason: 'incomplete' }, 'torrent_incomplete_after_hash'],
  ]) {
    let observations = 0;
    const result = await verifyStagedBatch({ root: '/staging', request, attempt,
      expectedTorrent, plannedFiles,
      observe: async () => ++observations === 1 ? { state: 'complete', files } : finalObservation,
      verify: async ({ relativePath }) => ({ state: 'identity_verified', isCorrupted: false,
        coverage: [{ episodeId: relativePath.includes('01') ? 1001 : 1002,
          start: 0, end: 100 }], fileId: relativePath.includes('01') ? 51 : 52,
        ed2k: 'B'.repeat(32), size: 3 }),
      lookup: async () => null,
    });
    assert.equal(observations, 2);
    assert.deepEqual(result, { state: 'held', reason });
  }
});

test('a changed selected subtitle after video hashing holds the pack', async () => {
  let observations = 0;
  const subtitle = { index: 2, name: 'Show/01.en.srt', size: 120 };
  const result = await verifyStagedBatch({ root: '/staging', request, attempt, expectedTorrent, plannedFiles,
    observe: async () => ({ state: 'complete', files,
      subtitles: [{ ...subtitle, size: ++observations === 1 ? 120 : 121 }] }),
    verify: async ({ relativePath }) => ({ state: 'identity_verified', isCorrupted: false,
      coverage: [{ episodeId: relativePath.includes('01') ? 1001 : 1002, start: 0, end: 100 }],
      fileId: relativePath.includes('01') ? 51 : 52, ed2k: 'B'.repeat(32), size: 3 }),
    verifySubtitle: async () => ({ state: 'subtitle_verified', sha256: 'A'.repeat(64), size: 120 }),
    lookup: async () => null,
  });
  assert.deepEqual(result, { state: 'held', reason: 'torrent_changed_after_hash' });
});

test('unchanged selected subtitles are recorded in identity evidence', async () => {
  const subtitle = { index: 2, name: 'Show/01.en.srt', size: 120 };
  const result = await verifyStagedBatch({ root: '/staging', request, attempt, expectedTorrent, plannedFiles,
    observe: async () => ({ state: 'complete', files, subtitles: [subtitle] }),
    verify: async ({ relativePath }) => ({ state: 'identity_verified', isCorrupted: false,
      coverage: [{ episodeId: relativePath.includes('01') ? 1001 : 1002, start: 0, end: 100 }],
      fileId: relativePath.includes('01') ? 51 : 52, ed2k: 'B'.repeat(32), size: 3 }),
    verifySubtitle: async () => ({ state: 'subtitle_verified', sha256: 'A'.repeat(64), size: 120 }),
    lookup: async () => null,
  });
  assert.equal(result.state, 'batch_identity_verified');
  assert.deepEqual(result.subtitles, [{ ...subtitle, sha256: 'A'.repeat(64) }]);
});

test('synthetic staged bytes pass only through exact AniDB file identities', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-batch-'));
  try {
    const bytes = [Buffer.from('abc'), Buffer.from('def')];
    await writeFile(path.join(root, '01.mkv'), bytes[0]);
    await writeFile(path.join(root, '02.mkv'), bytes[1]);
    const hashes = bytes.map(ed2kBuffer);
    const observations = [{ index: 0, name: '01.mkv', size: 3 },
      { index: 1, name: '02.mkv', size: 3 }];
    const result = await verifyStagedBatch({ root, request, attempt, expectedTorrent,
      plannedFiles: [{ name: '01.mkv', episodeIds: [1001] },
        { name: '02.mkv', episodeIds: [1002] }],
      observe: async () => ({ state: 'complete', files: observations }),
      lookup: async ({ ed2k, size }) => {
        const index = hashes.indexOf(ed2k);
        return { status: 200, release: {
          id: `anidb://${ed2k}+${size}`, providerName: 'AniDB', isCorrupted: false,
          releaseURI: `https://anidb.net/file/${51 + index}`, fileSize: size,
          hashes: [{ type: 'ED2K', value: ed2k }],
          crossReferences: [{ anidbAnimeID: 42, anidbEpisodeID: 1001 + index,
            percentageStart: null, percentageEnd: null }],
        } };
      },
    });
    assert.equal(result.state, 'batch_identity_verified');
    assert.deepEqual(result.files.map((file) => file.anidbFileId), [51, 52]);
    assert.equal(result.handoffReady, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
