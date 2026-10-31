import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTestApp } from '../src/web/app.mjs';
import { parsePrivateServerConfig } from '../src/web/private-server-config.mjs';
import { createCatalogueTestService } from '../src/catalogue/catalogue-service.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const token = 'synthetic-private-token';
const auth = { authorization: `Bearer ${token}` };
const makeApp = (searchReleases) => buildTestApp({ testToken: token,
  searchTitles: async () => ({ state: 'results', total: 0, page: 1, items: [] }), searchReleases });

test('private release search is authenticated and read-only', async () => {
  let calls = 0;
  const app = makeApp(async ({ query }) => { calls++; return { state: 'candidates', items: [
    { guid: 'release-1', title: query, evidence: 'unverified' }], exhaustive: false }; });
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/releases/search?q=Example' })).statusCode, 401);
    assert.equal(calls, 0);
    const response = await app.inject({ method: 'GET', url: '/api/releases/search?q=Example', headers: auth });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().items[0].evidence, 'unverified');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal((await app.inject({ method: 'POST', url: '/api/releases/search', headers: auth })).statusCode, 404);
    assert.equal(calls, 1);
  } finally { await app.close(); }
});

test('invalid search and missing Prowlarr hold without a network call', async () => {
  let calls = 0;
  const app = makeApp(async () => { calls++; return { state: 'unavailable' }; });
  const unconfigured = makeApp();
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/releases/search?q=x', headers: auth })).statusCode, 400);
    assert.equal(calls, 0);
    assert.equal((await app.inject({ method: 'GET', url: '/api/releases/search?q=Example', headers: auth })).statusCode, 503);
    assert.equal((await unconfigured.inject({ method: 'GET', url: '/api/releases/search?q=Example', headers: auth })).statusCode, 503);
  } finally { await app.close(); await unconfigured.close(); }
});

test('Prowlarr settings are optional but must be complete and scoped when present', () => {
  const env = { NEGEV_PRIVATE_TEST: '1', NEGEV_SHOKO_URL: 'http://shoko.internal:8111',
    NEGEV_SHOKO_API_KEY: 'synthetic-key', NEGEV_TEST_TOKEN: token, NEGEV_DATA_DIR: '/tmp/negev',
    NEGEV_PROWLARR_URL: 'http://prowlarr.internal:9696', NEGEV_PROWLARR_API_KEY: 'synthetic-search-key',
    NEGEV_PROWLARR_INDEXER_IDS: '7,9' };
  assert.deepEqual(parsePrivateServerConfig(env).prowlarrIndexerIds, [7, 9]);
  for (const change of [
    { NEGEV_PROWLARR_API_KEY: undefined },
    { NEGEV_PROWLARR_INDEXER_IDS: '' },
    { NEGEV_PROWLARR_INDEXER_IDS: '7,7' },
    { NEGEV_PROWLARR_URL: 'http://user:pass@prowlarr.internal:9696' },
  ]) assert.throws(() => parsePrivateServerConfig({ ...env, ...change }), TypeError);
});

test('configured private service searches Prowlarr without Shoko or grab calls', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-release-search-'));
  const calls = [];
  const service = createCatalogueTestService({
    shokoBaseUrl: 'http://shoko.internal:8111', shokoApiKey: 'synthetic-shoko-key',
    prowlarrBaseUrl: 'http://prowlarr.internal:9696', prowlarrApiKey: 'synthetic-prowlarr-key',
    prowlarrIndexerIds: [7], dbPath: path.join(dir, 'claims.sqlite'), testToken: token,
    fetchImpl: async (url, init) => {
      calls.push({ url: new URL(url), init });
      return { status: 200, text: async () => JSON.stringify([{
        guid: 'release-1', indexerId: 7, title: '[Group] Example', size: 1000,
        protocol: 'torrent', downloadUrl: 'https://private.invalid/download',
      }]) };
    },
  });
  try {
    const response = await service.app.inject({ method: 'GET', url: '/api/releases/search?q=Example', headers: auth });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().items[0].evidence, 'unverified');
    assert.equal(response.body.includes('private.invalid'), false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url.host, 'prowlarr.internal:9696');
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(calls[0].init.headers['X-Api-Key'], 'synthetic-prowlarr-key');
  } finally { await service.close(); await rm(dir, { recursive: true, force: true }); }
});
