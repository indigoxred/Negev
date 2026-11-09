import assert from 'node:assert/strict';
import test from 'node:test';
import { previewAniDbRelease } from '../src/identity/shoko-preview.mjs';

const options = {
  baseUrl: 'http://shoko.internal:8111',
  providerId: '11111111-2222-4333-8444-555555555555',
  apiKey: 'synthetic-test-key',
  ed2k: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  size: 123456789,
};

test('uses the installed read-only preview route with a header credential', async () => {
  let called;
  const result = await previewAniDbRelease({ ...options, fetchImpl: async (url, init) => {
    called = { url, init };
    return { status: 200, text: async () => '{"providerName":"AniDB"}' };
  } });
  const url = new URL(called.url);
  assert.equal(url.pathname, '/api/v3/ReleaseInfo/Provider/11111111-2222-4333-8444-555555555555/Preview/By-Release');
  assert.equal(url.searchParams.get('id'), 'anidb://AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA+123456789');
  assert.equal(url.searchParams.has('apikey'), false);
  assert.equal(called.init.method, 'GET');
  assert.equal(called.init.redirect, 'manual');
  assert.equal(called.init.headers.Authorization, 'Bearer synthetic-test-key');
  assert.deepEqual(result, { status: 200, release: { providerName: 'AniDB' } });
});

test('keeps Shoko 204 inconclusive and does not parse a response body', async () => {
  const result = await previewAniDbRelease({ ...options, fetchImpl: async () => ({ status: 204, text: async () => { throw Error('body read'); } }) });
  assert.deepEqual(result, { status: 204 });
});

test('ambiguous AniDB 204 needs no unrelated connectivity verdict', async () => {
  const paths = [];
  const result = await previewAniDbRelease({ ...options,
    fetchImpl: async (url) => {
      paths.push(new URL(url).pathname);
      return { status: 204 };
    } });
  assert.deepEqual(paths, [
    '/api/v3/ReleaseInfo/Provider/11111111-2222-4333-8444-555555555555/Preview/By-Release',
  ]);
  assert.deepEqual(result, { status: 204 });
});

test('converts transport failure and malformed JSON to provider-unavailable evidence', async () => {
  assert.deepEqual(await previewAniDbRelease({ ...options, fetchImpl: async () => { throw Error('network down'); } }), { status: 0 });
  assert.deepEqual(await previewAniDbRelease({ ...options, fetchImpl: async () => ({ status: 200, text: async () => 'not-json' }) }), { status: 0 });
});

test('rejects invalid provider IDs before constructing a request', async () => {
  await assert.rejects(previewAniDbRelease({ ...options, providerId: '../other', fetchImpl: async () => { throw Error('should not call'); } }), TypeError);
});
