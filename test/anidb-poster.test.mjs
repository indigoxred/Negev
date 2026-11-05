import assert from 'node:assert/strict';
import test from 'node:test';
import { readAniDbPoster } from '../src/catalogue/anidb-poster.mjs';

test('reads a poster only from the exact AniDB ID and fixed image host', async () => {
  const urls = [];
  const result = await readAniDbPoster({ anidbId: 4158,
    fetchImpl: async (url, options) => {
      urls.push(String(url));
      assert.equal(options.redirect, 'manual');
      return urls.length === 1
        ? new Response(JSON.stringify({ anidb_id: 4158, picture: '224210.jpg' }),
          { headers: { 'content-type': 'application/json' } })
        : new Response(Buffer.from([0xff, 0xd8, 0xff, 0x00]),
          { headers: { 'content-type': 'image/jpeg' } });
    } });
  assert.deepEqual(urls, ['https://animap.id/api/anidb/4158',
    'https://cdn.anidb.net/images/main/224210.jpg']);
  assert.equal(result.state, 'image');
  assert.equal(result.type, 'image/jpeg');
});

test('rejects mismatched identity, unsafe filenames and non-image bytes', async () => {
  for (const record of [{ anidb_id: 2, picture: '224210.jpg' },
    { anidb_id: 4158, picture: '../bad.jpg' }]) {
    let calls = 0;
    const result = await readAniDbPoster({ anidbId: 4158,
      fetchImpl: async () => { calls++; return new Response(JSON.stringify(record)); } });
    assert.equal(result.state, 'unavailable');
    assert.equal(calls, 1);
  }
  const result = await readAniDbPoster({ anidbId: 4158,
    fetchImpl: async (url) => String(url).includes('/api/anidb/')
      ? new Response(JSON.stringify({ anidb_id: 4158, picture: '1.jpg' }))
      : new Response('fake', { headers: { 'content-type': 'image/jpeg' } }) });
  assert.equal(result.state, 'unavailable');
});
