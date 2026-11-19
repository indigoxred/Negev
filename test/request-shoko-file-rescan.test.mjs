import assert from 'node:assert/strict';
import test from 'node:test';
import { requestShokoFileRescan } from
  '../src/acquisition/request-shoko-file-rescan.mjs';

test('requests one supported Shoko rescan for a positive file ID', async () => {
  let calls = 0;
  const result = await requestShokoFileRescan({
    baseUrl: 'http://shoko:8111/', apiKey: 'private', fileId: 81,
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url.href,
        'http://shoko:8111/api/v3/File/81/Rescan?priority=true');
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'manual');
      assert.equal(options.headers.Authorization, 'Bearer private');
      return new Response(null, { status: 200 });
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { state: 'accepted' });
});

test('failed or ambiguous Shoko rescan responses remain unconfirmed', async () => {
  for (const fetchImpl of [
    async () => new Response(null, { status: 503 }),
    async () => { throw new Error('connection lost after send'); },
  ]) {
    assert.deepEqual(await requestShokoFileRescan({
      baseUrl: 'http://shoko:8111/', apiKey: 'private', fileId: 81,
      fetchImpl,
    }), { state: 'unconfirmed' });
  }
});
