import assert from 'node:assert/strict';
import test from 'node:test';
import { previewShokoImportedRelease } from '../src/identity/shoko-auto-preview.mjs';

const options = { baseUrl: 'http://shoko.internal:8111/', apiKey: 'private-test',
  fileId: 19711 };
const response = (status, body) => ({ status,
  text: async () => JSON.stringify(body) });

test('Shoko checks its enabled providers without saving a release', async () => {
  let call;
  const result = await previewShokoImportedRelease({ ...options,
    fetchImpl: async (url, init) => {
      call = { url: new URL(url), init };
      return response(200, { ProviderName: 'AniDB', IsCorrupted: false,
        CrossReferences: [{ AnidbAnimeID: 42, AnidbEpisodeID: 1005,
          PercentageStart: 0, PercentageEnd: 100 }] });
    } });
  assert.equal(call.url.pathname,
    '/api/v3/ReleaseInfo/File/19711/AutoPreview');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.Authorization, 'Bearer private-test');
  assert.equal(call.url.searchParams.has('apikey'), false);
  assert.deepEqual(result, { state: 'match', release: {
    providerName: 'AniDB', isCorrupted: false,
    crossReferences: [{ animeId: 42, episodeId: 1005,
      start: 0, end: 100 }],
  } });
});

test('no provider match is inconclusive and a provider error remains unavailable', async () => {
  assert.deepEqual(await previewShokoImportedRelease({ ...options,
    fetchImpl: async () => response(204) }), { state: 'no_match' });
  assert.deepEqual(await previewShokoImportedRelease({ ...options,
    fetchImpl: async () => response(503) }),
  { state: 'unavailable', reason: 'http_503' });
});

test('a named Shoko fallback provider can be previewed without enabling it globally', async () => {
  let calledUrl;
  const providerId = 'ad205cd9-5452-49bc-9862-d6a021123abc';
  const result = await previewShokoImportedRelease({ ...options, providerIds: [providerId],
    fetchImpl: async (url) => {
      calledUrl = new URL(url);
      return response(204);
    } });
  assert.equal(calledUrl.searchParams.get('strict'), 'true');
  assert.equal(calledUrl.searchParams.get('providerIDs'), providerId);
  assert.deepEqual(result, { state: 'no_match' });
  await assert.rejects(previewShokoImportedRelease({ ...options,
    providerIds: ['not-a-provider-id'], fetchImpl: async () => response(204) }),
  TypeError);
});

test('a malformed provider result is never interpreted as a safe match', async () => {
  assert.deepEqual(await previewShokoImportedRelease({ ...options,
    fetchImpl: async () => response(200, { ProviderName: 'AniDB',
      IsCorrupted: false, CrossReferences: [] }) }),
  { state: 'unavailable', reason: 'invalid_response' });
});
