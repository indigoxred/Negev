import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTestApp } from '../src/web/app.mjs';

const token = 'synthetic-private-token';
const searchTitles = async () => ({ state: 'results', items: [] });
const auth = { authorization: `Bearer ${token}` };

test('private Plex key route is authenticated and returns only a bounded page', async () => {
  let calls = 0;
  const app = buildTestApp({ testToken: token, searchTitles,
    listPlexKeys: async (input) => {
      calls++;
      assert.deepEqual(input, { kind: 'episode', libraryId: 102, offset: 0 });
      return { state: 'page', libraryId: 102, kind: 'episode', offset: 0,
        totalSize: 100, keys: [512], complete: false };
    } });
  try {
    const denied = await app.inject({ method: 'GET',
      url: '/api/availability/plex/keys?kind=episode&libraryId=102' });
    assert.equal(denied.statusCode, 401);
    assert.equal(calls, 0);
    const response = await app.inject({ method: 'GET',
      url: '/api/availability/plex/keys?kind=episode&libraryId=102', headers: auth });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().keys, [512]);
    assert.equal(response.json().complete, false);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(calls, 1);
  } finally { await app.close(); }
});

test('invalid and unconfigured discovery never calls Plex', async () => {
  let calls = 0;
  const app = buildTestApp({ testToken: token, searchTitles,
    listPlexKeys: async () => { calls++; return { state: 'page', keys: [] }; } });
  try {
    for (const query of ['kind=show&libraryId=102', 'kind=episode&libraryId=0',
      'kind=movie&libraryId=9&offset=-1']) {
      const result = await app.inject({ method: 'GET',
        url: `/api/availability/plex/keys?${query}`, headers: auth });
      assert.equal(result.statusCode, 400);
    }
    assert.equal(calls, 0);
  } finally { await app.close(); }
  const disabled = buildTestApp({ testToken: token, searchTitles });
  try {
    const result = await disabled.inject({ method: 'GET',
      url: '/api/availability/plex/keys?kind=episode&libraryId=102', headers: auth });
    assert.equal(result.statusCode, 503);
  } finally { await disabled.close(); }
});
