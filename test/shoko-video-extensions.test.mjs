import assert from 'node:assert/strict';
import test from 'node:test';
import { readShokoVideoExtensions, acceptsShokoVideo } from
  '../src/acquisition/shoko-video-extensions.mjs';

test('reads Shoko import extensions and accepts only configured video formats', async () => {
  const result = await readShokoVideoExtensions({ baseUrl: 'http://shoko:8111/',
    apiKey: 'private', fetchImpl: async (url, options) => {
      assert.equal(new URL(url).pathname, '/api/v3/Settings');
      assert.equal(options.headers.Authorization, 'Bearer private');
      return new Response(JSON.stringify({ Import: { VideoExtensions: ['.mkv', '.ts'] } }),
        { status: 200 });
    } });
  assert.equal(result.state, 'extensions');
  assert.equal(acceptsShokoVideo('Episode.TS', result), true);
  assert.equal(acceptsShokoVideo('Episode.webm', result), false);
});

test('Shoko settings failure does not imply support for any video', async () => {
  const result = await readShokoVideoExtensions({ baseUrl: 'http://shoko:8111/',
    apiKey: 'private', fetchImpl: async () => new Response('', { status: 503 }) });
  assert.equal(result.state, 'unavailable');
  assert.equal(acceptsShokoVideo('Episode.mkv', result), false);
});
