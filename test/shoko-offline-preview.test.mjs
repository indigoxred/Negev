import assert from 'node:assert/strict';
import test from 'node:test';
import { previewOfflineRelease } from '../src/identity/shoko-offline-preview.mjs';

const providerId = '9a2da41e-8f9b-4ddb-aec8-7213399d840e';
const filename = 'Example.S01E01.mkv';
const base = { baseUrl: 'http://shoko.internal:8111', apiKey: 'private-key',
  filename };
const provider = { ID: providerId, Name: 'Offline Importer', IsEnabled: true };

test('discovers the enabled Shoko Offline Importer and previews only a basename', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (calls.length === 1) return Response.json([provider]);
    return Response.json({ ProviderName: 'Offline Importer',
      ID: 'offline://42-1001', OriginalFilename: filename });
  };
  const result = await previewOfflineRelease({ ...base, fetchImpl });
  assert.equal(result.status, 200);
  assert.equal(result.release.ID, 'offline://42-1001');
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[1].url).searchParams.get('id'),
    `search://${filename}`);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer private-key');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer private-key');
});

test('holds when the provider is disabled, absent, ambiguous or unavailable', async () => {
  for (const listing of [[], [{ ...provider, IsEnabled: false }],
    [provider, { ...provider, ID: '86d33f64-9dab-402f-a10a-3c1c3d67278d' }]]) {
    let calls = 0;
    assert.deepEqual(await previewOfflineRelease({ ...base,
      fetchImpl: async () => { calls++; return Response.json(listing); } }),
    { status: 0 });
    assert.equal(calls, 1);
  }
  assert.deepEqual(await previewOfflineRelease({ ...base,
    fetchImpl: async () => { throw Error('private-key in upstream error'); } }),
  { status: 0 });
});

test('returns a bounded empty preview without promoting it to a match', async () => {
  let calls = 0;
  const result = await previewOfflineRelease({ ...base,
    fetchImpl: async () => ++calls === 1 ? Response.json([provider])
      : new Response(null, { status: 204 }) });
  assert.deepEqual(result, { status: 204 });
});

test('rejects unsafe filename and URL before sending credentials', async () => {
  for (const changed of [{ filename: '../Example.mkv' },
    { filename: 'dir/Example.mkv' },
    { baseUrl: 'http://user:pass@shoko.internal:8111' }]) {
    await assert.rejects(() => previewOfflineRelease({ ...base, ...changed,
      fetchImpl: () => { throw Error('should not fetch'); } }), TypeError);
  }
});
