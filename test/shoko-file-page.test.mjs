import assert from 'node:assert/strict';
import test from 'node:test';
import { readShokoFilePage } from '../src/availability/shoko-file-page.mjs';

const base = { baseUrl: 'http://shoko.internal:8111', apiKey: 'synthetic-key',
  page: 2, pageSize: 2 };
const date = '2026-10-31T00:00:00Z';
const file = (id, seriesIDs) => ({ ID: id, Created: date, Updated: date,
  Imported: null, SeriesIDs: seriesIDs });
const json = (value) => new Response(JSON.stringify(value), { status: 200 });

test('one bounded Shoko file page distinguishes provisional and linked imports', async () => {
  const linked = [{ SeriesID: { AniDB: 42 }, EpisodeIDs: [{ AniDB: 1001 }] }];
  const result = await readShokoFilePage({ ...base, fetchImpl: async (url, init) => {
    assert.equal(url.pathname, '/api/v3/File');
    assert.equal(url.searchParams.get('page'), '2');
    assert.equal(url.searchParams.get('pageSize'), '2');
    assert.deepEqual(url.searchParams.getAll('include'), ['XRefs,ImportLimbo']);
    assert.equal(init.method, 'GET');
    assert.equal(init.headers.Authorization, 'Bearer synthetic-key');
    return json({ Total: 4, List: [file(10, null), file(11, linked)] });
  } });
  assert.deepEqual(result, { state: 'page', page: 2, total: 4,
    items: [{ fileId: 10, updated: date, state: 'provisional', pairs: [] },
      { fileId: 11, updated: date, state: 'linked',
        pairs: [{ anidbId: 42, episodeId: 1001 }] }] });
});

test('provider failures cannot imply absence, but one malformed file does not stop the page', async () => {
  assert.deepEqual(await readShokoFilePage({ ...base,
    fetchImpl: async () => new Response('', { status: 503 }) }),
  { state: 'unavailable' });
  assert.deepEqual(await readShokoFilePage({ ...base,
    fetchImpl: async () => json({ Total: 4, List: [file(10, [{ SeriesID: { AniDB: 42 },
      EpisodeIDs: [{ AniDB: null }] }]), file(11, [{ SeriesID: { AniDB: 42 },
      EpisodeIDs: [{ AniDB: 1001 }] }])] }) }),
  { state: 'page', page: 2, total: 4, items: [
    { fileId: 10, updated: date, state: 'unverified', pairs: [] },
    { fileId: 11, updated: date, state: 'linked',
      pairs: [{ anidbId: 42, episodeId: 1001 }] },
  ] });
});

test('rejects unbounded pages before contacting Shoko', async () => {
  await assert.rejects(readShokoFilePage({ ...base, pageSize: 1000,
    fetchImpl: async () => { throw new Error('must not fetch'); } }), TypeError);
});

test('new inventory reads use one stable 100-file page', async () => {
  const result = await readShokoFilePage({ baseUrl: base.baseUrl,
    apiKey: base.apiKey, fetchImpl: async (url) => {
      assert.equal(url.searchParams.get('pageSize'), '100');
      assert.equal(url.searchParams.get('sortOrder'), 'FileID');
      return json({ Total: 0, List: [] });
    } });
  assert.deepEqual(result, { state: 'page', page: 1, total: 0, items: [] });
});

test('opt-in page hints provide bounded source paths without changing episode identity', async () => {
  const linked = [{ SeriesID: { AniDB: 42 }, EpisodeIDs: [{ AniDB: 1001 }] }];
  const withPath = { ...file(11, linked), Size: 5,
    Locations: [{ FileID: 11, IsAccessible: true,
      AbsolutePath: '/pure/Anime/one.mkv' }] };
  const result = await readShokoFilePage({ ...base, includeHints: true,
    fetchImpl: async (url) => {
      assert.deepEqual(url.searchParams.getAll('include'),
        ['XRefs,AbsolutePaths,ImportLimbo']);
      return json({ Total: 4, List: [file(10, null), withPath] });
    } });
  assert.deepEqual(result, { state: 'page', page: 2, total: 4, items: [
    { fileId: 10, updated: date, state: 'provisional', pairs: [], hint: null },
    { fileId: 11, updated: date, state: 'linked',
      pairs: [{ anidbId: 42, episodeId: 1001 }],
      hint: { size: 5, sourcePaths: ['/pure/Anime/one.mkv'] } },
  ] });
  const unsafe = await readShokoFilePage({ ...base, includeHints: true,
    fetchImpl: async () => json({ Total: 4, List: [
      { ...withPath, Locations: [{ ...withPath.Locations[0],
        AbsolutePath: '/pure/../escape.mkv' }] },
      { ...withPath, ID: 12, Locations: [{ ...withPath.Locations[0],
        FileID: 12 }] }] }) });
  assert.equal(unsafe.items[0].state, 'linked');
  assert.equal(unsafe.items[0].hint, null);
  assert.deepEqual(unsafe.items[1].hint,
    { size: 5, sourcePaths: ['/pure/Anime/one.mkv'] });
});
