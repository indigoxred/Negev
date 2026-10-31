import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluatePreview } from '../src/identity/evaluate-preview.mjs';

const expected = {
  ed2k: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  size: 123456789,
  animeId: 42,
  episodeIds: [1001],
};

const registered = {
  id: `anidb://${expected.ed2k}+${expected.size}`,
  providerName: 'AniDB',
  releaseURI: 'https://anidb.net/file/123456',
  fileSize: expected.size,
  hashes: [{ type: 'ED2K', value: expected.ed2k }],
  crossReferences: [{ anidbAnimeID: 42, anidbEpisodeID: 1001,
    percentageStart: null, percentageEnd: null }],
};

test('accepts only an exact registered file and requested episode', () => {
  assert.deepEqual(evaluatePreview({ status: 200, release: registered }, expected), {
    state: 'accepted', reason: 'exact_anidb_release', fileId: 123456,
    coverage: [{ episodeId: 1001, start: 0, end: 100 }],
  });
});

test('accepts the installed Shoko v3 PascalCase JSON shape', () => {
  const shokoRelease = {
    ID: registered.id,
    ProviderName: 'AniDB',
    ReleaseURI: registered.releaseURI,
    FileSize: registered.fileSize,
    Hashes: [{ Type: 'ED2K', Value: expected.ed2k }],
    CrossReferences: [{ AnidbAnimeID: 42, AnidbEpisodeID: 1001,
      PercentageStart: null, PercentageEnd: null }],
  };
  assert.deepEqual(evaluatePreview({ status: 200, release: shokoRelease }, expected), {
    state: 'accepted', reason: 'exact_anidb_release', fileId: 123456,
    coverage: [{ episodeId: 1001, start: 0, end: 100 }],
  });
});

test('preserves exact AniDB half-episode coverage without claiming completion', () => {
  const release = structuredClone(registered);
  release.crossReferences[0].percentageStart = 0;
  release.crossReferences[0].percentageEnd = 50;
  assert.deepEqual(evaluatePreview({ status: 200, release }, expected).coverage,
    [{ episodeId: 1001, start: 0, end: 50 }]);
});

test('missing coverage fields are not manufactured into a full episode', () => {
  for (const pascal of [false, true]) {
    const release = structuredClone(registered);
    delete release.crossReferences[0].percentageStart;
    delete release.crossReferences[0].percentageEnd;
    const candidate = pascal ? { ID: release.id, ProviderName: release.providerName,
      ReleaseURI: release.releaseURI, FileSize: release.fileSize,
      Hashes: [{ Type: 'ED2K', Value: expected.ed2k }],
      CrossReferences: [{ AnidbAnimeID: 42, AnidbEpisodeID: 1001 }] } : release;
    assert.deepEqual(evaluatePreview({ status: 200, release: candidate }, expected),
      { state: 'held', reason: 'invalid_response' });
  }
});

test('one-sided, undefined, or invalid coverage stays held', () => {
  for (const values of [[null, undefined], [undefined, null],
    [undefined, undefined], [50, 0]]) {
    const release = structuredClone(registered);
    release.crossReferences[0].percentageStart = values[0];
    release.crossReferences[0].percentageEnd = values[1];
    assert.equal(evaluatePreview({ status: 200, release }, expected).state, 'held');
  }
});

test('rejects a registered file for another anime', () => {
  const release = structuredClone(registered);
  release.crossReferences[0].anidbAnimeID = 9999;
  assert.equal(evaluatePreview({ status: 200, release }, expected).reason, 'wrong_identity');
});

test('rejects missing or extra episode identities in a pack', () => {
  assert.equal(evaluatePreview({ status: 200, release: registered }, { ...expected, episodeIds: [1001, 1002] }).reason, 'wrong_identity');
  const release = structuredClone(registered);
  release.crossReferences.push({ anidbAnimeID: 42, anidbEpisodeID: 1002,
    percentageStart: null, percentageEnd: null });
  assert.equal(evaluatePreview({ status: 200, release }, expected).reason, 'wrong_identity');
});

test('holds a malformed or inconsistent release response', () => {
  for (const change of [
    { fileSize: expected.size + 1 },
    { id: 'anidb://OTHER+1' },
    { releaseURI: 'https://elsewhere.example/file/123456' },
    { hashes: [] },
    { crossReferences: [] },
  ]) {
    assert.equal(evaluatePreview({ status: 200, release: { ...registered, ...change } }, expected).state, 'held');
  }
});

test('keeps no-match separate from provider failures', () => {
  // Installed Shoko can also return 204 when its AniDB provider is banned.
  assert.deepEqual(evaluatePreview({ status: 204 }, expected), { state: 'held', reason: 'lookup_inconclusive' });
  assert.deepEqual(evaluatePreview({ status: 401 }, expected), { state: 'held', reason: 'provider_unavailable' });
  assert.deepEqual(evaluatePreview({ status: 200, release: null }, expected), { state: 'held', reason: 'invalid_response' });
});
