import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchProwlarrTorrentBytes } from '../src/acquisition/prowlarr-torrent-bytes.mjs';

const bytes = Uint8Array.from([100, 52, 58, 105, 110, 102, 111, 101]);
// Prowlarr DownloadMappingService builds {serverUrl}{urlBase}/{indexerId}/download.
const proxy = 'http://prowlarr.internal:9696/3/download?apikey=syntheticKey&link=abc123&file=Example';
const candidate = { guid: 'release-1', indexerId: 3, title: 'Example 01', size: 1_000 };
const config = { baseUrl: 'http://prowlarr.internal:9696/', apiKey: 'syntheticKey',
  query: 'Example', candidate, indexerIds: [3] };
const release = { ...candidate, protocol: 'torrent', downloadUrl: proxy };

test('fetches only the matching Prowlarr-proxied torrent bytes without redirecting', async () => {
  const calls = [];
  const result = await fetchProwlarrTorrentBytes({ ...config, fetchImpl: async (url, init) => {
    calls.push({ url: new URL(url), init });
    return calls.length === 1
      ? Response.json([release])
      : new Response(bytes, { headers: { 'content-type': 'application/x-bittorrent' } });
  } });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.pathname, '/api/v1/search');
  assert.equal(calls[1].url.pathname, '/3/download');
  assert.equal(calls.every(({ init }) => init.method === 'GET' && init.redirect === 'manual' &&
    init.headers['X-Api-Key'] === 'syntheticKey'), true);
  assert.equal(result.state, 'torrent_bytes');
  assert.deepEqual(result.bytes, bytes);
});

test('a missing, duplicate, or changed candidate never retrieves bytes', async () => {
  for (const items of [[], [{ ...release, guid: 'other' }], [release, release],
    [{ ...release, protocol: 'usenet' }], [{ ...release, title: 'Other 01' }],
    [{ ...release, size: 2_000 }]]) {
    let calls = 0;
    const result = await fetchProwlarrTorrentBytes({ ...config, fetchImpl: async () => {
      calls++;
      if (calls > 1) throw Error('unexpected proxy request');
      return Response.json(items);
    } });
    assert.equal(result.state, 'held');
    assert.equal(calls, 1);
  }
});

test('refuses proxy URLs that could escape Prowlarr or change authentication', async () => {
  for (const downloadUrl of [
    'http://evil.invalid/torrent',
    'http://prowlarr.internal:9696/4/download?apikey=syntheticKey&link=x&file=x',
    'http://prowlarr.internal:9696/3/download?apikey=other&link=x&file=x',
    'http://prowlarr.internal:9696/3/download?apikey=syntheticKey&link=x&file=x&redirect=1',
  ]) {
    let calls = 0;
    const result = await fetchProwlarrTorrentBytes({ ...config, fetchImpl: async () => {
      calls++;
      if (calls > 1) throw Error('unexpected proxy request');
      return Response.json([{ ...release, downloadUrl }]);
    } });
    assert.equal(result.state, 'held');
    assert.equal(calls, 1);
  }
});

test('redirects, wrong content type and oversized torrent responses remain held', async () => {
  for (const proxyResponse of [
    new Response(null, { status: 302, headers: { location: 'https://evil.invalid/' } }),
    new Response('magnet:?xt=urn:btih:abc', { headers: { 'content-type': 'text/plain' } }),
    new Response(new Uint8Array(2_000_001), { headers: { 'content-type': 'application/x-bittorrent' } }),
  ]) {
    const result = await fetchProwlarrTorrentBytes({ ...config, fetchImpl: async (url) =>
      new URL(url).pathname === '/api/v1/search' ? Response.json([release]) : proxyResponse });
    assert.equal(result.state, 'held');
  }
});

test('invalid candidate and provider failure do not disclose bytes', async () => {
  await assert.rejects(() => fetchProwlarrTorrentBytes({ ...config, candidate: { ...candidate, guid: '' },
    fetchImpl: async () => { throw Error('unexpected call'); } }), TypeError);
  const result = await fetchProwlarrTorrentBytes({ ...config, fetchImpl: async () => { throw Error('offline'); } });
  assert.deepEqual(result, { state: 'held', reason: 'provider_unavailable' });
});

test('revalidation accepts a selected candidate among an aggregate of 60 results', async () => {
  const many = Array.from({ length: 59 }, (_, n) => ({ ...release, guid: `other-${n}` }));
  let calls = 0;
  const result = await fetchProwlarrTorrentBytes({ ...config, fetchImpl: async () => {
    calls++;
    return calls === 1 ? Response.json([...many, release]) :
      new Response(bytes, { headers: { 'content-type': 'application/x-bittorrent' } });
  } });
  assert.equal(result.state, 'torrent_bytes');
  assert.equal(calls, 2);
});

test('configured Prowlarr URL base scopes both search and proxy', async () => {
  const paths = [];
  const result = await fetchProwlarrTorrentBytes({ ...config,
    baseUrl: 'http://prowlarr.internal:9696/prowlarr/',
    fetchImpl: async (url) => {
      paths.push(new URL(url).pathname);
      return paths.length === 1 ? Response.json([{ ...release,
        downloadUrl: proxy.replace(':9696/3/', ':9696/prowlarr/3/') }]) :
        new Response(bytes, { headers: { 'content-type': 'application/x-bittorrent' } });
    } });
  assert.equal(result.state, 'torrent_bytes');
  assert.deepEqual(paths, ['/prowlarr/api/v1/search', '/prowlarr/3/download']);
});
