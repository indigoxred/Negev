import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyShokoSourceFolder } from '../src/acquisition/shoko-source-folder.mjs';

const input = { baseUrl: 'http://shoko.internal:8111/', apiKey: 'private-test',
  folderId: 2, shokoPath: '/negev/source' };
const folder = { ID: 2, Path: '/negev/source',
  DropFolderType: 'Source', WatchForNewFiles: true };

test('dedicated Shoko source must match its exact watched folder ID and path', async () => {
  const urls = [];
  const fetchImpl = async (url, init) => {
    urls.push(url.pathname);
    assert.equal(init.method, 'GET');
    assert.equal(init.headers.Authorization, 'Bearer private-test');
    return Response.json(folder);
  };
  assert.deepEqual(await verifyShokoSourceFolder({ ...input, fetchImpl }),
    { state: 'verified_shoko_source' });
  assert.deepEqual(urls, ['/api/v3/ManagedFolder/2']);
  for (const change of [{ ID: 1 }, { Path: '/other' },
    { DropFolderType: 'Destination' }, { WatchForNewFiles: false }]) {
    assert.deepEqual(await verifyShokoSourceFolder({ ...input,
      fetchImpl: async () => Response.json({ ...folder, ...change }) }),
    { state: 'held', reason: 'shoko_source_unverified' });
  }
  assert.deepEqual(await verifyShokoSourceFolder({ ...input,
    fetchImpl: async () => new Response(null, { status: 401 }) }),
  { state: 'held', reason: 'shoko_source_unverified' });
});
