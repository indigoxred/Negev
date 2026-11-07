import assert from 'node:assert/strict';
import test from 'node:test';
import { readShokoImportedFile } from '../src/identity/shoko-imported-file.mjs';

const options = { baseUrl: 'http://shoko.internal:8111/', apiKey: 'test-key',
  ed2k: 'A'.repeat(32), size: 900 };
const file = { ID: 19711, Size: 900,
  Hashes: [{ Type: 'ED2K', Value: 'A'.repeat(32) }] };
const response = (body, status = 200) => ({ status,
  text: async () => JSON.stringify(body) });

test('uses only the scoped Shoko hash lookup and keeps the token in a header', async () => {
  let call;
  const result = await readShokoImportedFile({ ...options, fetchImpl: async (url, init) => {
    call = { url: new URL(url), init };
    return response(file);
  } });
  assert.equal(call.url.pathname, '/api/v3/File/Hash/ED2K');
  assert.equal(call.url.searchParams.get('hash'), options.ed2k);
  assert.equal(call.url.searchParams.get('size'), '900');
  assert.equal(call.url.searchParams.get('include'), 'XRefs,ReleaseInfo');
  assert.equal(call.url.searchParams.has('apikey'), false);
  assert.equal(call.init.method, 'GET');
  assert.equal(call.init.headers.Authorization, 'Bearer test-key');
  assert.deepEqual(result, { state: 'imported_unrecognized', fileId: 19711,
    ed2k: options.ed2k, size: 900 });
});

test('404 means Shoko has not yet indexed those exact bytes', async () => {
  assert.deepEqual(await readShokoImportedFile({ ...options,
    fetchImpl: async () => response({}, 404) }), { state: 'not_imported' });
});

test('optional location proof reads only accessible Shoko paths for the same file', async () => {
  let include;
  const result = await readShokoImportedFile({ ...options,
    includeAbsolutePaths: true, fetchImpl: async (url) => {
      include = new URL(url).searchParams.get('include');
      return response({ ...file, Locations: [
        { ID: 1, FileID: 19711, ManagedFolderID: 1,
          AbsolutePath: '/pure/Import/05.mkv', IsAccessible: true },
        { ID: 2, FileID: 19711, ManagedFolderID: 2,
          AbsolutePath: '/pure/Anime/Show/05.mkv', IsAccessible: true },
      ] });
    } });
  assert.equal(include, 'XRefs,ReleaseInfo,AbsolutePaths');
  assert.deepEqual(result.locations, [
    { managedFolderId: 1, path: '/pure/Import/05.mkv', accessible: true },
    { managedFolderId: 2, path: '/pure/Anime/Show/05.mkv', accessible: true },
  ]);
});

test('an unavailable duplicate location does not hide a valid final copy', async () => {
  const result = await readShokoImportedFile({ ...options,
    includeAbsolutePaths: true, fetchImpl: async () => response({ ...file,
      Locations: [
        { ID: 1, FileID: 19711, ManagedFolderID: 1,
          IsAccessible: false },
        { ID: 2, FileID: 19711, ManagedFolderID: 2,
          AbsolutePath: '/pure/Anime/Show/05.mkv', IsAccessible: true },
      ] }) });
  assert.deepEqual(result.locations, [
    { managedFolderId: 1, path: null, accessible: false },
    { managedFolderId: 2, path: '/pure/Anime/Show/05.mkv', accessible: true },
  ]);
});

test('returns release identity without deciding whether it matches the request', async () => {
  const result = await readShokoImportedFile({ ...options,
    fetchImpl: async () => response({ ...file, Release: { ProviderName: 'AniDB',
      ID: `anidb://${options.ed2k}+900`, IsCorrupted: false,
      CrossReferences: [{ AnidbAnimeID: 19823, AnidbEpisodeID: 318041,
        PercentageStart: 0, PercentageEnd: 100 }] } }) });
  assert.deepEqual(result, { state: 'imported_recognized', fileId: 19711,
    ed2k: options.ed2k, size: 900, release: { providerName: 'AniDB',
      id: `anidb://${options.ed2k}+900`, isCorrupted: false,
      crossReferences: [{ animeId: 19823, episodeId: 318041,
        start: 0, end: 100 }] } });
});

test('does not relabel a Shoko release that points at another episode', async () => {
  const result = await readShokoImportedFile({ ...options,
    fetchImpl: async () => response({ ...file, Release: { ProviderName: 'User',
      ID: null, IsCorrupted: false, CrossReferences: [{
        AnidbAnimeID: 999, AnidbEpisodeID: 888,
        PercentageStart: 0, PercentageEnd: 100 }] } }) });
  assert.equal(result.state, 'imported_recognized');
  assert.deepEqual(result.release.crossReferences, [{ animeId: 999,
    episodeId: 888, start: 0, end: 100 }]);
});

test('refuses conflicting bytes or malformed release evidence', async () => {
  for (const body of [
    { ...file, Size: 901 },
    { ...file, Hashes: [{ Type: 'ED2K', Value: 'B'.repeat(32) }] },
    { ...file, Release: { ProviderName: 'AniDB', CrossReferences: [] } },
    { ...file, Release: { ProviderName: 'AniDB', CrossReferences: [
      { AnidbAnimeID: 19823, AnidbEpisodeID: 318041,
        PercentageStart: 100, PercentageEnd: 0 }] } },
  ]) {
    assert.deepEqual(await readShokoImportedFile({ ...options,
      fetchImpl: async () => response(body) }),
    { state: 'unavailable', reason: 'invalid_response' });
  }
});

test('transport and non-404 HTTP failure remain unavailable', async () => {
  assert.deepEqual(await readShokoImportedFile({ ...options,
    fetchImpl: async () => { throw Error('offline'); } }),
  { state: 'unavailable', reason: 'transport' });
  assert.deepEqual(await readShokoImportedFile({ ...options,
    fetchImpl: async () => response({}, 503) }),
  { state: 'unavailable', reason: 'http_503' });
});
