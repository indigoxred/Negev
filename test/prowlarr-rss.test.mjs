import assert from 'node:assert/strict';
import test from 'node:test';
import { readProwlarrRss } from '../src/acquisition/prowlarr-rss.mjs';

const config = { baseUrl: 'http://prowlarr.internal:9696', apiKey: 'test-key',
  indexerId: 5 };

test('reads the existing indexer feed without placing credentials in the URL', async () => {
  let request;
  const result = await readProwlarrRss({ ...config,
    fetchImpl: async (url, init) => {
      request = { url, init };
      return new Response(`<?xml version="1.0"?><rss><channel>
        <item><title>[Group] Example &amp; Friends - 01</title>
        <guid>https://nyaa.si/view/123</guid><pubDate>Sun, 15 Nov 2026 01:00:00 GMT</pubDate></item>
        </channel></rss>`, { status: 200 });
    } });
  assert.equal(new URL(request.url).pathname, '/5/api');
  assert.equal(new URL(request.url).searchParams.get('t'), 'search');
  assert.equal(new URL(request.url).searchParams.has('apikey'), false);
  assert.equal(request.init.headers['X-Api-Key'], 'test-key');
  assert.deepEqual(result, { state: 'feed', items: [{
    guid: 'https://nyaa.si/view/123', title: '[Group] Example & Friends - 01',
    indexerId: 5, publishedMs: Date.parse('Sun, 15 Nov 2026 01:00:00 GMT'),
  }] });
});

test('rate limits, malformed XML and oversized feeds cannot mean no releases', async () => {
  const limited = await readProwlarrRss({ ...config,
    fetchImpl: async () => new Response('', { status: 429,
      headers: { 'Retry-After': '120' } }) });
  assert.deepEqual(limited, { state: 'unavailable', retryAfterMs: 120_000 });
  const invalid = await readProwlarrRss({ ...config,
    fetchImpl: async () => new Response('<rss><item><title>Bad</title></rss>') });
  assert.deepEqual(invalid, { state: 'unavailable' });
  const huge = await readProwlarrRss({ ...config,
    fetchImpl: async () => new Response('x'.repeat(2_000_001)) });
  assert.deepEqual(huge, { state: 'unavailable' });
});

test('accepts an XML-escaped magnet GUID without treating its query separator as malformed', async () => {
  const result = await readProwlarrRss({ ...config,
    fetchImpl: async () => new Response(`<rss><channel><item>
      <title><![CDATA[Example <Anime> 01]]></title>
      <guid>magnet:?xt=urn:btih:abc&amp;dn=Example</guid>
      </item></channel></rss>`) });
  assert.equal(result.state, 'feed');
  assert.equal(result.items[0].guid, 'magnet:?xt=urn:btih:abc&dn=Example');
  assert.equal(result.items[0].title, 'Example <Anime> 01');
});
