import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTestApp } from '../src/web/app.mjs';
import { createObservedTitleRegistry } from '../src/catalogue/observed-title-registry.mjs';

const testToken = 'synthetic-private-token';

test('health is available and search requires the private test token', async () => {
  let calls = 0;
  const app = buildTestApp({ testToken, searchTitles: async () => { calls++; return { state: 'results', total: 0, page: 1, items: [] }; } });
  try {
    const health = await app.inject({ method: 'GET', url: '/health/live' });
    assert.equal(health.statusCode, 200);
    assert.deepEqual(health.json(), { status: 'ok' });
    const denied = await app.inject({ method: 'GET', url: '/api/catalogue/search?q=Example' });
    assert.equal(denied.statusCode, 401);
    assert.equal(calls, 0);
  } finally { await app.close(); }
});

test('valid search returns non-requestable title results without secrets', async () => {
  let args;
  const app = buildTestApp({ testToken, searchTitles: async (input) => {
    args = input;
    return { state: 'results', total: 1, page: 2, items: [{ anidbId: 1234, title: 'Example Anime', detailState: 'pending', requestable: false }] };
  } });
  try {
    const response = await app.inject({ method: 'GET', url: '/api/catalogue/search?q=Example&page=2', headers: { authorization: `Bearer ${testToken}` } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(args, { query: 'Example', page: 2 });
    assert.equal(response.json().items[0].requestable, false);
    assert.equal(response.body.includes(testToken), false);
    assert.equal(response.headers['cache-control'], 'no-store');
  } finally { await app.close(); }
});

test('invalid query does not hit Shoko', async () => {
  const app = buildTestApp({ testToken, searchTitles: async () => { throw Error('must not search'); } });
  try {
    for (const url of ['/api/catalogue/search?q=a', '/api/catalogue/search?q=Example&page=0']) {
      const response = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${testToken}` } });
      assert.equal(response.statusCode, 400);
    }
  } finally { await app.close(); }
});

test('Shoko outage is a 503 rather than an empty catalogue', async () => {
  const app = buildTestApp({ testToken, searchTitles: async () => ({ state: 'unavailable' }) });
  try {
    const response = await app.inject({ method: 'GET', url: '/api/catalogue/search?q=Example', headers: { authorization: `Bearer ${testToken}` } });
    assert.equal(response.statusCode, 503);
  } finally { await app.close(); }
});

test('detail route keeps an unowned title pending and never requestable', async () => {
  const app = buildTestApp({ testToken, searchTitles: async () => ({ state: 'results', total: 0, page: 1, items: [] }),
    loadDetail: async ({ anidbId }) => ({ state: 'detail_pending', anidbId }) });
  try {
    const denied = await app.inject({ method: 'GET', url: '/api/catalogue/1234' });
    assert.equal(denied.statusCode, 401);
    const response = await app.inject({ method: 'GET', url: '/api/catalogue/1234', headers: { authorization: `Bearer ${testToken}` } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { state: 'detail_pending', anidbId: 1234, requestable: false });
  } finally { await app.close(); }
});

test('only the private POST detail-load action may invoke hydration', async () => {
  let calls = 0;
  const titleRegistry = createObservedTitleRegistry();
  const app = buildTestApp({ testToken, titleRegistry,
    searchTitles: async () => ({ state: 'results', total: 1, page: 1,
      items: [{ anidbId: 1234, title: 'Example', requestable: false }] }),
    loadDetail: async () => ({ state: 'detail_pending', anidbId: 1234 }),
    hydrateTitle: async () => { calls++; return { state: 'pending', reason: 'refresh_queued' }; } });
  try {
    const read = await app.inject({ method: 'GET', url: '/api/catalogue/1234', headers: { authorization: `Bearer ${testToken}` } });
    assert.equal(read.statusCode, 200);
    assert.equal(calls, 0);
    const denied = await app.inject({ method: 'POST', url: '/api/catalogue/1234/load-detail' });
    assert.equal(denied.statusCode, 401);
    assert.equal(calls, 0);
    const unseen = await app.inject({ method: 'POST', url: '/api/catalogue/1234/load-detail', headers: { authorization: `Bearer ${testToken}` } });
    assert.equal(unseen.statusCode, 409);
    assert.equal(calls, 0);
    await app.inject({ method: 'GET', url: '/api/catalogue/search?q=Example', headers: { authorization: `Bearer ${testToken}` } });
    const load = await app.inject({ method: 'POST', url: '/api/catalogue/1234/load-detail', headers: { authorization: `Bearer ${testToken}` } });
    assert.equal(load.statusCode, 202);
    assert.deepEqual(load.json(), { state: 'pending', reason: 'refresh_queued' });
    assert.equal(calls, 1);
  } finally { await app.close(); }
});

test('search records an exact title for the later detail-load action', async () => {
  const registry = createObservedTitleRegistry();
  const app = buildTestApp({ testToken, titleRegistry: registry,
    searchTitles: async () => ({ state: 'results', total: 1, page: 1,
      items: [{ anidbId: 1234, title: 'Example', requestable: false }] }),
    hydrateTitle: async ({ anidbId }) => ({ state: registry.isKnownTitle({ anidbId }) ? 'pending' : 'held',
      reason: registry.isKnownTitle({ anidbId }) ? 'refresh_queued' : 'unknown_title' }) });
  try {
    const auth = { authorization: `Bearer ${testToken}` };
    const before = await app.inject({ method: 'POST', url: '/api/catalogue/1234/load-detail', headers: auth });
    assert.equal(before.statusCode, 409);
    const searched = await app.inject({ method: 'GET', url: '/api/catalogue/search?q=Example', headers: auth });
    assert.equal(searched.statusCode, 200);
    const after = await app.inject({ method: 'POST', url: '/api/catalogue/1234/load-detail', headers: auth });
    assert.equal(after.statusCode, 202);
    const other = await app.inject({ method: 'POST', url: '/api/catalogue/9999/load-detail', headers: auth });
    assert.equal(other.statusCode, 409);
  } finally { await app.close(); }
});

test('a failed catalogue search does not record a title', async () => {
  const registry = createObservedTitleRegistry();
  const app = buildTestApp({ testToken, titleRegistry: registry,
    searchTitles: async () => ({ state: 'unavailable' }) });
  try {
    const response = await app.inject({ method: 'GET', url: '/api/catalogue/search?q=Example',
      headers: { authorization: `Bearer ${testToken}` } });
    assert.equal(response.statusCode, 503);
    assert.equal(registry.isKnownTitle({ anidbId: 1234 }), false);
  } finally { await app.close(); }
});

