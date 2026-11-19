import assert from 'node:assert/strict';
import test from 'node:test';
import { searchReleaseCandidates } from '../src/acquisition/prowlarr-search.mjs';

const config = { baseUrl: 'http://prowlarr.internal:9696', apiKey: 'synthetic-key', indexerIds: [7, 9] };

test('trusted-filter indexer is preferred by identity while ordinary Nyaa remains eligible', async () => {
  const result = await searchReleaseCandidates({ ...config,
    trustedIndexerIds: [7], query: 'Example Anime',
    fetchImpl: async () => Response.json([
      { guid: 'trusted', indexerId: 7, title: 'Example 1080p',
        size: 1000, protocol: 'torrent', seeders: 8 },
      { guid: 'ordinary', indexerId: 9, title: 'Example 1080p',
        size: 1000, protocol: 'torrent', seeders: 20 },
    ]) });
  assert.deepEqual(result.items.map((item) => item.trusted), [true, undefined]);
  assert.deepEqual(await searchReleaseCandidates({ ...config,
    trustedIndexerIds: [12], query: 'Example Anime',
    fetchImpl: async () => { throw Error('network call'); } }),
  { state: 'invalid_query' });
});

test('uses only read-only search and returns unverified, sanitized candidates', async () => {
  let called;
  const result = await searchReleaseCandidates({ ...config, query: 'Example Anime', fetchImpl: async (url, init) => {
    called = { url, init };
    return { status: 200, text: async () => JSON.stringify([{
      guid: 'release-1', indexerId: 7, title: '[Group] Example Anime - 01', size: 12345,
      protocol: 'torrent', seeders: 4, downloadUrl: 'https://secret.invalid/torrent?key=private',
      magnetUrl: 'magnet:?xt=urn:btih:secret', infoHash: 'a'.repeat(40),
    }]) };
  } });
  const url = new URL(called.url);
  assert.equal(url.pathname, '/api/v1/search');
  assert.equal(url.searchParams.get('query'), 'Example Anime');
  assert.equal(url.searchParams.get('type'), 'search');
  assert.deepEqual(url.searchParams.getAll('indexerIds'), ['7', '9']);
  assert.equal(url.searchParams.get('limit'), '25');
  assert.equal(url.searchParams.has('apikey'), false);
  assert.equal(called.init.method, 'GET');
  assert.equal(called.init.redirect, 'manual');
  assert.equal(called.init.headers['X-Api-Key'], 'synthetic-key');
  assert.deepEqual(result, { state: 'candidates', items: [{
    guid: 'release-1', indexerId: 7, title: '[Group] Example Anime - 01', size: 12345,
    protocol: 'torrent', seeders: 4, evidence: 'unverified',
  }] });
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('private acquisition search retains only a Prowlarr proxy from its own result', async () => {
  const proxy = 'http://prowlarr.internal:9696/7/download?apikey=synthetic-key&link=abc123&file=Example';
  const result = await searchReleaseCandidates({ ...config, query: 'Example Anime',
    includeProxyUrl: true,
    fetchImpl: async () => Response.json([
      { guid: 'good', indexerId: 7, title: 'Example 01', size: 12345,
        protocol: 'torrent', seeders: 8, downloadUrl: proxy },
      { guid: 'bad', indexerId: 9, title: 'Example 02', size: 12345,
        protocol: 'torrent', seeders: 8, downloadUrl: 'https://evil.invalid/download' },
    ]) });
  assert.equal(result.items[0].proxyUrl, proxy);
  assert.equal(result.items[1].proxyUrl, undefined);
});

test('rejects unscoped indexer search and invalid input without a network call', async () => {
  const fetchImpl = async () => { throw Error('must not call'); };
  assert.deepEqual(await searchReleaseCandidates({ ...config, indexerIds: [], query: 'Example', fetchImpl }), { state: 'invalid_query' });
  assert.deepEqual(await searchReleaseCandidates({ ...config, query: 'x', fetchImpl }), { state: 'invalid_query' });
  assert.deepEqual(await searchReleaseCandidates({ ...config, query: 'x'.repeat(121), fetchImpl }), { state: 'invalid_query' });
});

test('holds failed or malformed responses rather than claiming no release exists', async () => {
  for (const response of [
    { status: 503 },
    { status: 200, text: async () => '{}' },
    { status: 200, text: async () => JSON.stringify([{ guid: '', indexerId: 7, title: 'Bad', size: 12 }]) },
    { status: 200, text: async () => JSON.stringify([{ guid: 'x', indexerId: 12, title: 'Other indexer', size: 12 }]) },
  ]) {
    assert.deepEqual(await searchReleaseCandidates({ ...config, query: 'Example', fetchImpl: async () => response }), { state: 'unavailable' });
  }
});

test('empty successful result remains provisional because Prowlarr can hide search failures', async () => {
  const result = await searchReleaseCandidates({ ...config, query: 'Example', fetchImpl: async () => ({ status: 200, text: async () => '[]' }) });
  assert.deepEqual(result, { state: 'candidates', items: [], exhaustive: false });
});

test('multi-indexer aggregate may exceed the query limit without hiding valid results', async () => {
  const data = Array.from({ length: 30 }, (_, n) => ({ guid: `g${n}`,
    indexerId: n < 15 ? 7 : 9, title: `Release ${n}`, size: 100 + n,
    protocol: 'torrent' }));
  const result = await searchReleaseCandidates({ ...config, query: 'Example', limit: 25,
    fetchImpl: async () => Response.json(data) });
  assert.equal(result.state, 'candidates');
  assert.equal(result.items.length, 25);
});

test('accepts bounded Prowlarr magnet GUIDs from SubsPlease', async () => {
  const guid = `magnet:?xt=urn:btih:${'a'.repeat(810)}`;
  const item = { guid, indexerId: 9, title: 'Example Anime 01', size: 12345,
    protocol: 'torrent', seeders: 1 };
  const result = await searchReleaseCandidates({ ...config, query: 'Example Anime',
    fetchImpl: async () => Response.json([item]) });
  assert.equal(result.state, 'candidates');
  assert.equal(result.items[0].guid, guid);
  assert.deepEqual(await searchReleaseCandidates({ ...config, query: 'Example Anime',
    fetchImpl: async () => Response.json([{ ...item, guid: `magnet:${'a'.repeat(2100)}` }]) }),
  { state: 'unavailable' });
});

test('a large first indexer response does not hide candidates from a later indexer', async () => {
  const data = [7, 9].flatMap((indexerId) => Array.from({ length: 30 }, (_, n) => ({
    guid: `${indexerId}-${n}`, indexerId, title: `Release ${n}`, size: 100 + n,
    protocol: 'torrent' })));
  const result = await searchReleaseCandidates({ ...config, query: 'Example', limit: 5,
    fetchImpl: async () => Response.json(data) });
  assert.deepEqual(result.items.map((item) => item.indexerId), [7, 9, 7, 9, 7]);
  assert.deepEqual(result.items.map((item) => item.guid), ['7-0', '9-0', '7-1', '9-1', '7-2']);
});

test('an exact episode beyond the raw indexer page is retained and preferred', async () => {
  const data = Array.from({ length: 60 }, (_, n) => ({
    guid: `release-${n}`, indexerId: 7,
    title: n === 53 ? 'Example S01E01 1080p English Subs' :
      n === 54 ? 'Example S01E01 720p English Subs' :
        `Example S01E${String(n + 10).padStart(2, '0')} 1080p`,
    size: 1000 + n, protocol: 'torrent', seeders: n === 53 ? 50 : 5,
  }));
  const search = async (input) => searchReleaseCandidates({ ...config,
    query: 'Example 01', limit: 5, fetchImpl: async () => Response.json(data), ...input });
  const targeted = await search({ targetEpisodeNumber: 1 });
  assert.equal(targeted.state, 'candidates');
  assert.equal(targeted.items[0].guid, 'release-53');
  assert.equal(targeted.items[1].guid, 'release-54');
  const untargeted = await search({});
  assert.equal(untargeted.items[0].guid, 'release-0');
  assert.deepEqual(await search({ targetEpisodeNumber: 0 }), { state: 'invalid_query' });
});
