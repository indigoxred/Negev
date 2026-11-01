import assert from 'node:assert/strict';
import test from 'node:test';
import { readShokoRecentPage, scanShokoRecentSince } from
  '../src/availability/shoko-recent-catchup.mjs';

const imported = (hour) => `2026-10-13T${String(hour).padStart(2, '0')}:00:00Z`;
const cursor = (fileId, hour) => ({ fileId,
  importedNs: String(Date.parse(imported(hour)) * 1_000_000) });
const row = (fileId, hour) => ({ ID: fileId, Imported: imported(hour) });
const json = (value) => new Response(JSON.stringify(value), { status: 200 });

test('recent Shoko page uses installed import-time order and exact timezone timestamp', async () => {
  const result = await readShokoRecentPage({ baseUrl: 'http://shoko.local/',
    apiKey: 'private-test-key', page: 2, pageSize: 2,
    fetchImpl: async (url, init) => {
      assert.equal(url.pathname, '/api/v3/File');
      assert.equal(url.searchParams.get('sortOrder'), '-ImportedAt,-FileID');
      assert.equal(url.searchParams.get('include'), 'ImportLimbo');
      assert.equal(url.searchParams.get('page'), '2');
      assert.equal(url.searchParams.get('pageSize'), '2');
      assert.equal(init.headers.Authorization, 'Bearer private-test-key');
      return json({ Total: 3, List: [
        { ID: 11, Imported: '2026-10-13T10:00:00.1234567+10:00' },
      ] });
    } });
  assert.deepEqual(result, { state: 'page', page: 2, total: 3,
    items: [{ fileId: 11, importedNs: String(
      BigInt(Date.parse('2026-10-13T00:00:00Z')) * 1_000_000n + 123_456_700n) }] });
});

test('two stable pages return new file IDs oldest first and one new watermark', async () => {
  const pages = { 1: { Total: 4, List: [row(13, 13), row(12, 12)] },
    2: { Total: 4, List: [row(11, 11), row(10, 10)] } };
  const calls = [];
  const result = await scanShokoRecentSince({ since: cursor(10, 10),
    pageSize: 2, maxPages: 3, readPage: async ({ page }) => {
      calls.push(page);
      return { state: 'page', page, total: pages[page].Total,
        items: pages[page].List.map((item) => cursor(item.ID,
          Number(item.Imported.slice(11, 13)))) };
    } });
  assert.deepEqual(result, { state: 'complete', fileIds: [11, 12, 13],
    newest: cursor(13, 13) });
  assert.deepEqual(calls, [1, 2, 1]);
});

test('an empty watermark sees the first imported file without skipping it', async () => {
  const empty = { fileId: 1, importedNs: '0' };
  const readPage = async () => ({ state: 'page', page: 1, total: 1,
    items: [cursor(1, 1)] });
  assert.deepEqual(await scanShokoRecentSince({ since: empty, readPage }),
    { state: 'complete', fileIds: [1], newest: cursor(1, 1) });
  assert.deepEqual(await scanShokoRecentSince({ since: empty,
    readPage: async () => ({ state: 'page', page: 1, total: 0,
      items: [] }) }), { state: 'complete', fileIds: [], newest: empty });
  assert.deepEqual(await scanShokoRecentSince({ since: cursor(1, 1),
    readPage: async () => ({ state: 'page', page: 1, total: 0,
      items: [] }) }), { state: 'held', reason: 'recent_head_older' });
});

test('equal import timestamps use descending file ID without dropping a file', async () => {
  const result = await scanShokoRecentSince({ since: cursor(11, 10),
    pageSize: 3, readPage: async () => ({ state: 'page', page: 1, total: 3,
      items: [cursor(13, 10), cursor(12, 10), cursor(11, 10)] }) });
  assert.deepEqual(result, { state: 'complete', fileIds: [12, 13],
    newest: cursor(13, 10) });
});

test('changed page total or first page refuses a new watermark', async () => {
  for (const changed of ['total', 'head']) {
    let reads = 0;
    const result = await scanShokoRecentSince({ since: cursor(10, 10),
      pageSize: 1, maxPages: 3, readPage: async ({ page }) => {
        reads++;
        if (reads === 1) return { state: 'page', page, total: 2,
          items: [cursor(11, 11)] };
        if (reads === 2) return { state: 'page', page, total: changed === 'total' ? 3 : 2,
          items: [cursor(10, 10)] };
        return { state: 'page', page, total: 2,
          items: [cursor(12, 12)] };
      } });
    assert.equal(result.state, 'held');
  }
});

test('over-budget gaps and malformed timestamps never advance the cursor', async () => {
  const gap = await scanShokoRecentSince({ since: cursor(1, 1),
    pageSize: 1, maxPages: 2, readPage: async ({ page }) => ({
      state: 'page', page, total: 3,
      items: [cursor(page === 1 ? 3 : 2, page === 1 ? 3 : 2)] }) });
  assert.deepEqual(gap, { state: 'held', reason: 'recent_gap_exceeds_budget' });
  const malformed = await readShokoRecentPage({ baseUrl: 'http://shoko.local/',
    apiKey: 'private-test-key', fetchImpl: async () => json({ Total: 1,
      List: [{ ID: 1, Imported: '2026-10-13T10:00:00' }] }) });
  assert.deepEqual(malformed, { state: 'unavailable' });
});

test('a one-page head shift cannot be mistaken for no new files', async () => {
  let calls = 0;
  const result = await scanShokoRecentSince({ since: cursor(10, 10),
    pageSize: 1, readPage: async () => ({ state: 'page', page: 1, total: 1,
      items: [++calls === 1 ? cursor(10, 10) : cursor(11, 11)] }) });
  assert.deepEqual(result, { state: 'held', reason: 'recent_head_changed' });
  assert.equal(calls, 2);
});

test('an older current head cannot regress the saved import watermark', async () => {
  const result = await scanShokoRecentSince({ since: cursor(10, 10),
    pageSize: 1, readPage: async () => ({ state: 'page', page: 1, total: 1,
      items: [cursor(9, 9)] }) });
  assert.deepEqual(result, { state: 'held', reason: 'recent_head_older' });
});
