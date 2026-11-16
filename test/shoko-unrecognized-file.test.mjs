import assert from 'node:assert/strict';
import test from 'node:test';
import { readShokoUnrecognizedFile } from
  '../src/acquisition/shoko-unrecognized-file.mjs';

test('requires Shoko explicit Unrecognized membership for the exact file ID', async () => {
  const seen = [];
  const read = (fileId, page) => readShokoUnrecognizedFile({
    baseUrl: 'http://shoko:8111/', apiKey: 'private', fileId,
    fetchImpl: async (url, init) => {
      const parsed = new URL(url);
      seen.push([parsed.pathname, parsed.searchParams.get('include_only'),
        parsed.searchParams.get('pageSize'),
        init.headers.Authorization]);
      return Response.json(page);
    },
  });
  assert.deepEqual(await read(81, { Total: 2, List: [{ ID: 70 },
    { ID: 81 }] }), { state: 'unrecognized' });
  assert.deepEqual(await read(82, { Total: 1, List: [{ ID: 81 }] }),
    { state: 'not_unrecognized' });
  assert.deepEqual(await read(81, { Total: 101, List: [{ ID: 81 }] }),
    { state: 'unavailable' });
  assert.deepEqual(seen[0], ['/api/v3/File', 'Unrecognized', '100',
    'Bearer private']);
});
