import assert from 'node:assert/strict';
import test from 'node:test';
import { readShokoEd2kMode } from '../src/identity/shoko-ed2k-mode.mjs';

const configId = '2d7c4078-08cb-4334-bfcb-8eaf9829473d';
const provider = (enabled = ['ED2K']) => ({
  Name: 'Built-In Hasher', EnabledHashTypes: enabled,
  Configuration: { ID: configId },
});
const response = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

test('holds the native preference because Shoko can fall back per file', async () => {
  const calls = [];
  const result = await readShokoEd2kMode({ baseUrl: 'http://shoko:8111/', apiKey: 'secret',
    fetchImpl: async (url, options) => {
      calls.push({ path: url.pathname, method: options.method,
        auth: options.headers.Authorization });
      return response(calls.length === 1 ? [provider()] : { AlwaysUseSharpHasher: false });
    } });
  assert.deepEqual(result, { state: 'unavailable' });
  assert.deepEqual(calls, [
    { path: '/api/v3/Hashing/Provider', method: 'GET', auth: 'Bearer secret' },
    { path: `/api/v3/Configuration/${configId}`, method: 'GET', auth: 'Bearer secret' },
  ]);
});

test('reads forced managed hasher as the eDonkey boundary mode', async () => {
  const result = await readShokoEd2kMode({ baseUrl: 'http://shoko:8111/', apiKey: 'secret',
    fetchImpl: async (url) => response(url.pathname.endsWith('/Provider')
      ? [provider()] : { AlwaysUseSharpHasher: true }) });
  assert.deepEqual(result, { state: 'mode', mode: 'edonkey', basis: 'forced_sharp' });
});

test('ambiguous ED2K providers, missing settings, and auth failures hold', async () => {
  const cases = [
    async () => response([provider(), { ...provider(), Name: 'Other' }]),
    async () => response([provider(['CRC32'])]),
    async () => response([provider()]),
    async () => response({ error: 'unauthorized' }, 401),
  ];
  for (const first of cases) {
    let calls = 0;
    const result = await readShokoEd2kMode({ baseUrl: 'http://shoko:8111/',
      apiKey: 'secret', fetchImpl: async () => {
        calls++;
        return calls === 1 ? first() : response({ unrelated: false });
      } });
    assert.deepEqual(result, { state: 'unavailable' });
  }
});
