import assert from 'node:assert/strict';
import test from 'node:test';
import { readShokoPoster } from '../src/catalogue/shoko-poster.mjs';

const uid = '123e4567-e89b-42d3-a456-426614174000';
const config = { baseUrl: 'http://shoko.internal:8111', apiKey: 'synthetic' };

test('reads a bounded cached image through the fixed Shoko path', async () => {
  let called;
  const result = await readShokoPoster({ ...config, uid,
    fetchImpl: async (url, init) => {
      called = { url, init };
      return new Response(Buffer.from([1, 2, 3]),
        { headers: { 'content-type': 'image/jpeg' } });
    } });
  assert.equal(new URL(called.url).pathname, `/api/v3/Image/${uid}`);
  assert.equal(called.init.headers.Authorization, 'Bearer synthetic');
  assert.deepEqual(result, { state: 'image', type: 'image/jpeg',
    bytes: Buffer.from([1, 2, 3]) });
});

test('rejects malformed IDs, non-images and oversized responses', async () => {
  await assert.rejects(() => readShokoPoster({ ...config, uid: '../bad' }), TypeError);
  const nonImage = await readShokoPoster({ ...config, uid,
    fetchImpl: async () => new Response('not an image') });
  assert.equal(nonImage.state, 'unavailable');
  const huge = await readShokoPoster({ ...config, uid,
    fetchImpl: async () => new Response('x', { headers: {
      'content-type': 'image/png', 'content-length': '2000001' } }) });
  assert.equal(huge.state, 'unavailable');
});
