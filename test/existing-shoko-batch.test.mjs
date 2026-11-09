import assert from 'node:assert/strict';
import test from 'node:test';
import { checkExistingShokoBatch } from '../src/acquisition/existing-shoko-batch.mjs';

const video = { name: '05.mkv', episodeIds: [318041],
  identitySource: 'shoko_offline', releaseId: 'offline://19823-318041',
  ed2k: 'A'.repeat(32), size: 881498360 };
const imported = { anidbId: 19823, episodeIds: [318041],
  anidbFileId: null, releaseEvidence: 'shoko_offline_link',
  releaseId: video.releaseId, ed2k: video.ed2k, size: video.size,
  fileId: 19794, sourcePaths: ['/pure/Anime/Firefly/05.mkv'],
  coverage: [{ episodeId: 318041, start: 0, end: 100 }] };
const verified = { state: 'batch_identity_verified', anidbId: 19823,
  files: [video] };

test('an existing exact Shoko import prevents a second handoff copy', async () => {
  const result = await checkExistingShokoBatch({ verified,
    readEpisode: async () => ({ state: 'ok', complete: true,
      files: [imported] }) });
  assert.deepEqual(result, { state: 'held', reason: 'already_imported' });
});

test('an empty exact episode permits the first handoff', async () => {
  const result = await checkExistingShokoBatch({ verified,
    readEpisode: async () => ({ state: 'ok', complete: true, files: [] }) });
  assert.deepEqual(result, { state: 'no_matching_import' });
});

test('a different file on the episode does not claim the candidate imported', async () => {
  const result = await checkExistingShokoBatch({ verified,
    readEpisode: async () => ({ state: 'ok', complete: true,
      files: [{ ...imported, ed2k: 'B'.repeat(32) }] }) });
  assert.deepEqual(result, { state: 'no_matching_import' });
});

test('Shoko errors cannot authorize a copy', async () => {
  const result = await checkExistingShokoBatch({ verified,
    readEpisode: async () => ({ state: 'unavailable' }) });
  assert.deepEqual(result, { state: 'held', reason: 'shoko_unavailable' });
});

test('registered AniDB releases keep their existing first-import route', async () => {
  const result = await checkExistingShokoBatch({
    verified: { ...verified, files: [{ ...video,
      identitySource: 'anidb', releaseId: undefined, anidbFileId: 51 }] },
    readEpisode: async () => { throw new Error('new anime metadata not cached yet'); },
  });
  assert.deepEqual(result, { state: 'no_matching_import' });
});

test('a partially imported batch is held before copying any of its videos', async () => {
  const second = { ...video, name: '06.mkv', episodeIds: [318042],
    releaseId: 'offline://19823-318042', ed2k: 'B'.repeat(32) };
  const result = await checkExistingShokoBatch({
    verified: { ...verified, files: [video, second] },
    readEpisode: async ({ episodeId }) => episodeId === 318041
      ? { state: 'ok', complete: true, files: [imported] }
      : { state: 'ok', complete: true, files: [] },
  });
  assert.deepEqual(result, { state: 'held', reason: 'partial_existing_import' });
});

test('uncertain Shoko file lists hold the batch even when one exact file appears', async () => {
  const result = await checkExistingShokoBatch({ verified,
    readEpisode: async () => ({ state: 'ok', complete: false,
      files: [imported] }) });
  assert.deepEqual(result, { state: 'held', reason: 'shoko_unavailable' });
});
