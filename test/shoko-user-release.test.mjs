import assert from 'node:assert/strict';
import test from 'node:test';
import { saveShokoUserRelease } from '../src/identity/shoko-user-release.mjs';

const body = { ProviderName: 'User', Version: 1, FileSize: 900,
  IsCorrupted: false, IsDeprecated: false, Source: 'Unknown',
  CrossReferences: [{ AnidbAnimeID: 42, AnidbEpisodeID: 1005,
    PercentageStart: 0, PercentageEnd: 100 }],
  Updated: '2026-11-07T00:00:00.000Z', Created: '2026-11-07T00:00:00.000Z',
  PreventRescan: false, DeferToNext: false };

test('save uses Shoko supported file release action with redirect disabled', async () => {
  const result = await saveShokoUserRelease({ baseUrl: 'http://shoko:8111',
    apiKey: 'private', fileId: 19711, body,
    fetchImpl: async (url, options) => {
      assert.equal(url.pathname, '/api/v3/ReleaseInfo/File/19711');
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'manual');
      assert.equal(options.headers.Authorization, 'Bearer private');
      assert.deepEqual(JSON.parse(options.body), body);
      return { status: 201 };
    } });
  assert.deepEqual(result, { state: 'saved' });
});

test('save does not report success for errors, redirects, or transport failure', async () => {
  for (const status of [200, 302, 400, 401, 500]) {
    const result = await saveShokoUserRelease({ baseUrl: 'http://shoko:8111',
      apiKey: 'private', fileId: 19711, body,
      fetchImpl: async () => ({ status }) });
    assert.equal(result.state, 'unavailable');
  }
  assert.deepEqual(await saveShokoUserRelease({
    baseUrl: 'http://shoko:8111', apiKey: 'private', fileId: 19711, body,
    fetchImpl: async () => { throw new Error('offline'); } }),
  { state: 'unavailable', reason: 'transport' });
});
