import assert from 'node:assert/strict';
import test from 'node:test';
import { readShokoFileCandidate } from
  '../src/availability/shoko-file-candidate.mjs';

const ed2k = 'A'.repeat(32);
const refs = [1001, 1002].map((episodeId) => ({ AnidbAnimeID: 42,
  AnidbEpisodeID: episodeId, PercentageStart: null,
  PercentageEnd: null }));
const file = { ID: 51, Updated: '2026-11-01T00:00:00Z', Size: 123,
  IsIgnored: false, Hashes: [{ Type: 'ED2K', Value: ed2k }],
  SeriesIDs: [{ SeriesID: { AniDB: 42 }, EpisodeIDs:
    [{ AniDB: 1001 }, { AniDB: 1002 }] }],
  Release: { ID: `anidb://${ed2k}+123`, ProviderName: 'AniDB',
    ReleaseURI: 'https://anidb.net/file/800', FileSize: 123,
    IsCorrupted: false, Hashes: [{ Type: 'ED2K', Value: ed2k }],
    CrossReferences: refs },
  Locations: [{ FileID: 51, IsAccessible: true,
    AbsolutePath: '/pure/Anime/Example/01-02.mkv' }] };
const base = { baseUrl: 'http://shoko.internal:8111',
  apiKey: 'synthetic-key', fileId: 51 };
const json = (value) => new Response(JSON.stringify(value), { status: 200 });

test('one exact Shoko file read nominates all fully linked episodes for later Plex proof', async () => {
  const result = await readShokoFileCandidate({ ...base,
    fetchImpl: async (url, init) => {
      assert.equal(url.pathname, '/api/v3/File/51');
      assert.deepEqual(url.searchParams.getAll('include'), ['XRefs', 'ReleaseInfo']);
      assert.equal(url.searchParams.get('includeAbsolutePaths'), 'true');
      assert.equal(init.method, 'GET');
      assert.equal(init.redirect, 'manual');
      return json(file);
    } });
  assert.deepEqual(result, { state: 'candidate', fileId: 51, size: 123,
    anidbFileId: 800, releaseEvidence: 'registered',
    pairs: [{ anidbId: 42, episodeId: 1001 },
      { anidbId: 42, episodeId: 1002 }],
    sourcePaths: ['/pure/Anime/Example/01-02.mkv'] });
});

test('unrecognized, partial, corrupt, and contradictory files cannot nominate episodes', async () => {
  for (const changed of [
    { ...file, SeriesIDs: [] },
    { ...file, Release: { ...file.Release, IsCorrupted: true } },
    { ...file, Release: { ...file.Release, CrossReferences: [
      { ...refs[0], PercentageStart: 0, PercentageEnd: 50 }, refs[1]] } },
    { ...file, Release: { ...file.Release, CrossReferences: [refs[0]] } },
    { ...file, Release: { ...file.Release, CrossReferences: [null, refs[1]] } },
    { ...file, Hashes: {} },
    { ...file, Hashes: [{ Type: 'ED2K', Value: 'bad' }] },
    { ...file, Locations: [{ ...file.Locations[0], IsAccessible: false }] },
    { ...file, Locations: [{ ...file.Locations[0], AbsolutePath: '../outside.mkv' }] },
    { ...file, IsIgnored: true },
    { ...file, ID: 52 },
  ]) {
    assert.deepEqual(await readShokoFileCandidate({ ...base,
      fetchImpl: async () => json(changed) }), { state: 'unavailable' });
  }
});

test('a supported Shoko User link can nominate exact episodes without claiming AniDB registration', async () => {
  const userFile = { ...file, Release: { ID: null, ProviderName: 'User',
    IsCorrupted: false, CrossReferences: refs } };
  const result = await readShokoFileCandidate({ ...base,
    fetchImpl: async () => json(userFile) });
  assert.equal(result.state, 'candidate');
  assert.equal(result.releaseEvidence, 'shoko_user_link');
  assert.equal(result.anidbFileId, null);
  assert.equal(result.pairs.length, 2);
});

test('Shoko outage or missing exact file stays inconclusive', async () => {
  assert.deepEqual(await readShokoFileCandidate({ ...base,
    fetchImpl: async () => new Response('', { status: 404 }) }),
  { state: 'unavailable' });
  assert.deepEqual(await readShokoFileCandidate({ ...base,
    fetchImpl: async () => { throw Error('offline'); } }),
  { state: 'unavailable' });
});
