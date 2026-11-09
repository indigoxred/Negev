import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateOfflinePreview } from '../src/identity/evaluate-offline-preview.mjs';

const expected = { animeId: 42, episodeIds: [1001],
  filename: 'Example.S01E01.mkv' };
const release = {
  ProviderName: 'Offline Importer', ID: 'offline://42-1001',
  IsCorrupted: false, OriginalFilename: expected.filename,
  CrossReferences: [{ AnidbAnimeID: 42, AnidbEpisodeID: 1001,
    PercentageStart: 0, PercentageEnd: 100 }],
};

test('accepts one exact full-episode Shoko offline preview without claiming AniDB registration', () => {
  assert.deepEqual(evaluateOfflinePreview({ status: 200, release }, expected), {
    state: 'accepted', reason: 'exact_shoko_offline_link',
    releaseId: 'offline://42-1001',
    coverage: [{ episodeId: 1001, start: 0, end: 100 }],
  });
});

test('does not turn an unavailable or empty offline provider result into identity proof', () => {
  assert.deepEqual(evaluateOfflinePreview({ status: 204 }, expected),
    { state: 'held', reason: 'offline_lookup_inconclusive' });
  assert.deepEqual(evaluateOfflinePreview({ status: 503 }, expected),
    { state: 'held', reason: 'provider_unavailable' });
});

test('rejects a different anime, episode or supplied filename', () => {
  for (const changed of [
    { ID: 'offline://43-1001' },
    { CrossReferences: [{ ...release.CrossReferences[0], AnidbEpisodeID: 1002 }] },
    { OriginalFilename: 'Other.S01E01.mkv' },
  ]) {
    assert.deepEqual(evaluateOfflinePreview({ status: 200,
      release: { ...release, ...changed } }, expected),
    { state: 'rejected', reason: 'wrong_identity' });
  }
});

test('holds partial, ambiguous, corrupt or malformed offline evidence', () => {
  for (const changed of [
    { ProviderName: 'AniDB' }, { IsCorrupted: true },
    { CrossReferences: [{ ...release.CrossReferences[0], PercentageEnd: 50 }] },
    { CrossReferences: [release.CrossReferences[0], release.CrossReferences[0]] },
    { CrossReferences: [{ AnidbAnimeID: 42, AnidbEpisodeID: 1001 }] },
  ]) {
    assert.deepEqual(evaluateOfflinePreview({ status: 200,
      release: { ...release, ...changed } }, expected),
    { state: 'held', reason: 'invalid_offline_evidence' });
  }
});
