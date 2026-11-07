import assert from 'node:assert/strict';
import test from 'node:test';
import { commitProvisionalShokoLink } from '../src/acquisition/commit-provisional-shoko-link.mjs';

const plan = { state: 'link_ready', fileId: 19711, anidbId: 42,
  episodeId: 1005, ed2k: 'A'.repeat(32), size: 900,
  ownedPath: '/pure/Import/Negev/negev-7-digest/05.mkv' };
const unrecognized = { state: 'imported_unrecognized', fileId: 19711,
  ed2k: plan.ed2k, size: 900, locations: [{ managedFolderId: 1,
    path: plan.ownedPath, accessible: true }] };
const recognized = { ...unrecognized, state: 'imported_recognized',
  release: { providerName: 'User', isCorrupted: false,
    crossReferences: [{ animeId: 42, episodeId: 1005, start: 0, end: 100 }] } };

test('a fresh owned Shoko file can be linked only after native preview has no match', async () => {
  let reads = 0;
  let writes = 0;
  const result = await commitProvisionalShokoLink({ plan,
    readImportedFile: async () => (++reads === 3 ? recognized : unrecognized),
    previewRelease: async () => ({ state: 'no_match' }),
    saveRelease: async (fileId, body) => {
      writes++;
      assert.equal(fileId, plan.fileId);
      assert.equal(body.ProviderName, 'User');
      assert.equal(body.FileSize, plan.size);
      assert.equal(body.PreventRescan, false);
      assert.deepEqual(body.CrossReferences, [{ AnidbAnimeID: 42,
        AnidbEpisodeID: 1005, PercentageStart: 0, PercentageEnd: 100 }]);
      return { state: 'saved' };
    } });
  assert.deepEqual(result, { state: 'shoko_link_verified', fileId: 19711 });
  assert.equal(reads, 3);
  assert.equal(writes, 1);
});

test('a native match or conflicting preview must never be overwritten', async () => {
  for (const preview of [
    { state: 'match', release: recognized.release },
    { state: 'match', release: { ...recognized.release,
      crossReferences: [{ animeId: 99, episodeId: 999,
        start: 0, end: 100 }] } },
    { state: 'unavailable', reason: 'transport' },
  ]) {
    let writes = 0;
    const result = await commitProvisionalShokoLink({ plan,
      readImportedFile: async () => unrecognized,
      previewRelease: async () => preview,
      saveRelease: async () => { writes++; } });
    assert.equal(result.state, 'held');
    assert.equal(writes, 0);
  }
});

test('changed bytes, lost ownership, or a late Shoko match blocks the save', async () => {
  for (const second of [
    { ...unrecognized, size: 901 },
    { ...unrecognized, locations: [{ managedFolderId: 1,
      path: '/pure/Import/Other/05.mkv', accessible: true }] },
    recognized,
  ]) {
    let reads = 0;
    let writes = 0;
    const result = await commitProvisionalShokoLink({ plan,
      readImportedFile: async () => ++reads === 1 ? unrecognized : second,
      previewRelease: async () => ({ state: 'no_match' }),
      saveRelease: async () => { writes++; } });
    assert.equal(result.state, 'held');
    assert.equal(writes, 0);
  }
});

test('a saved link is not treated as success until Shoko returns the exact release', async () => {
  let reads = 0;
  const result = await commitProvisionalShokoLink({ plan,
    readImportedFile: async () => ++reads === 3 ? unrecognized : unrecognized,
    previewRelease: async () => ({ state: 'no_match' }),
    saveRelease: async () => ({ state: 'saved' }) });
  assert.deepEqual(result, { state: 'held', reason: 'shoko_link_unverified' });
});

test('owned Import can be configured without a server-specific path', async () => {
  const other = { ...plan,
    ownedPath: '/library/Import/Negev/negev-7-digest/05.mkv' };
  const observed = { ...unrecognized, locations: [{ managedFolderId: 2,
    path: other.ownedPath, accessible: true }] };
  let reads = 0;
  const result = await commitProvisionalShokoLink({ plan: other,
    readImportedFile: async () => ++reads === 3
      ? { ...recognized, locations: observed.locations } : observed,
    previewRelease: async () => ({ state: 'no_match' }),
    saveRelease: async () => ({ state: 'saved' }) });
  assert.equal(result.state, 'shoko_link_verified');
});
