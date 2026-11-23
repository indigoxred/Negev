import assert from 'node:assert/strict';
import test from 'node:test';
import { readShokoFileIdPage, scanShokoFileIdsSince } from
  '../src/availability/shoko-fileid-catchup.mjs';

const page = (ids, total = ids.length, number = 1) => ({ state: 'page',
  page: number, total, fileIds: ids });

test('newest file-ID page includes Shoko files with null Imported', async () => {
  const result = await readShokoFileIdPage({
    baseUrl: 'http://shoko.local/', apiKey: 'test-token', pageSize: 3,
    fetchImpl: async (url, init) => {
      assert.equal(url.searchParams.get('sortOrder'), '-FileID');
      assert.equal(url.searchParams.get('pageSize'), '3');
      assert.equal(init.headers.Authorization, 'Bearer test-token');
      return new Response(JSON.stringify({ Total: 3, List: [
        { ID: 20088, Imported: null },
        { ID: 20087, Imported: null },
        { ID: 20086, Imported: null },
      ] }), { status: 200 });
    },
  });
  assert.deepEqual(result, page([20088, 20087, 20086]));
});

test('file-ID catch-up journals only newer IDs in ascending order', async () => {
  const readPage = async ({ page: number }) => number === 1
    ? page([20088, 20087, 20086], 5, 1)
    : page([20085, 20084], 5, 2);
  assert.deepEqual(await scanShokoFileIdsSince({ readPage, sinceId: 20085,
    pageSize: 3 }), { state: 'complete', fileIds: [20086, 20087, 20088],
    newestId: 20088 });
});

test('initial file-ID catch-up rechecks one bounded newest page', async () => {
  const readPage = async () => page([20088, 20087, 20086]);
  assert.deepEqual(await scanShokoFileIdsSince({ readPage, sinceId: null,
    pageSize: 3 }), { state: 'complete', fileIds: [20086, 20087, 20088],
    newestId: 20088 });
});

test('changed head or a gap beyond the page budget does not advance', async () => {
  let calls = 0;
  const moving = await scanShokoFileIdsSince({ sinceId: 20085, pageSize: 3,
    readPage: async () => {
      calls++;
      return calls === 1 ? page([20088, 20087, 20086], 3) :
        page([20089, 20088, 20087], 3);
    } });
  assert.equal(moving.reason, 'file_id_head_changed');
  const gap = await scanShokoFileIdsSince({ sinceId: 1, pageSize: 2,
    maxPages: 1, readPage: async () => page([20088, 20087], 3) });
  assert.equal(gap.state, 'continuing');
  assert.deepEqual(gap.fileIds, [20087, 20088]);
  assert.equal(gap.continuation.page, 2);
});
