import assert from 'node:assert/strict';
import test from 'node:test';
import { searchReleaseCandidates } from '../src/acquisition/prowlarr-search.mjs';

const config = { baseUrl: 'http://prowlarr.internal:9696', apiKey: 'synthetic-key', indexerIds: [7, 9] };

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
