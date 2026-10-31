import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTestApp } from '../src/web/app.mjs';

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
