import assert from 'node:assert/strict';
import test from 'node:test';
import { readPlexSectionKeys } from '../src/availability/plex-section-keys.mjs';

const base = { baseUrl: 'http://plex:32400/', token: 'synthetic',
  libraryId: 102, kind: 'episode', offset: 0, pageSize: 24 };
const page = { MediaContainer: { size: 2, totalSize: 150, offset: 0,
  librarySectionID: 102, Metadata: [
    { ratingKey: '512', type: 'episode', librarySectionID: 102 },
    { ratingKey: '513', type: 'episode', librarySectionID: 102 },
  ] } };
const withSection = (reply, libraryId = 102, type = '4') => async (url, options) =>
  url.pathname === `/library/sections/${libraryId}`
    ? Response.json({ MediaContainer: { librarySectionID: libraryId,
      Directory: [{ type, key: `/library/sections/${libraryId}/all?type=${type}` }] } })
    : reply(url, options);

test('uses the section advertised type pivot before requesting an episode page', async () => {
  const paths = [];
  const result = await readPlexSectionKeys({ ...base, fetchImpl: async (url) => {
    paths.push(`${url.pathname}${url.search}`);
    if (url.pathname === '/library/sections/102') {
      return Response.json({ MediaContainer: { librarySectionID: 102,
        Directory: [{ type: '4', key: '/library/sections/102/all?type=4' }] } });
    }
    return Response.json(page);
  } });
  assert.deepEqual(paths, ['/library/sections/102?includeDetails=1',
    '/library/sections/102/all?type=4&sort=addedAt%3Adesc']);
  assert.deepEqual(result.keys, [512, 513]);
});

test('reads one bounded, section-scoped Plex key page without exposing file paths', async () => {
  let calls = 0;
  const result = await readPlexSectionKeys({ ...base, fetchImpl: withSection(async (url, options) => {
    calls++;
    assert.equal(url.pathname, '/library/sections/102/all');
    assert.equal(url.searchParams.get('type'), '4');
    assert.equal(url.searchParams.get('sort'), 'addedAt:desc');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers['X-Plex-Container-Start'], '0');
    assert.equal(options.headers['X-Plex-Container-Size'], '24');
    assert.equal(options.headers['X-Plex-Token'], 'synthetic');
    return Response.json(page);
  }) });
  assert.equal(calls, 1);
  assert.deepEqual(result, { state: 'page', libraryId: 102, kind: 'episode',
    offset: 0, totalSize: 150, keys: [512, 513], complete: false });
});

test('a movie page uses movie type and remains non-exhaustive even when empty', async () => {
  const result = await readPlexSectionKeys({ ...base, libraryId: 9, kind: 'movie',
    fetchImpl: withSection(async (url) => {
      assert.equal(url.searchParams.get('type'), '1');
      return Response.json({ MediaContainer: { size: 0, totalSize: 0, offset: 0,
        librarySectionID: 9, Metadata: [] } });
    }, 9, '1') });
  assert.deepEqual(result, { state: 'page', libraryId: 9, kind: 'movie',
    offset: 0, totalSize: 0, keys: [], complete: false });
});

test('an omitted optional total still yields keys without claiming completeness', async () => {
  const result = await readPlexSectionKeys({ ...base,
    fetchImpl: withSection(async () => Response.json({ MediaContainer: {
      size: 1, offset: 0, librarySectionID: 102,
      Metadata: [page.MediaContainer.Metadata[0]],
    } })) });
  assert.deepEqual(result, { state: 'page', libraryId: 102, kind: 'episode',
    offset: 0, totalSize: null, keys: [512], complete: false });
});

test('accepts Plex pagination response headers when the JSON body omits offset and total', async () => {
  const result = await readPlexSectionKeys({ ...base, offset: 25,
    fetchImpl: withSection(async () => new Response(JSON.stringify({ MediaContainer: {
      size: 2, librarySectionID: 102, Metadata: page.MediaContainer.Metadata,
    } }), { status: 200, headers: { 'content-type': 'application/json',
      'X-Plex-Container-Start': '25', 'X-Plex-Container-Total-Size': '150' } })) });
  assert.deepEqual(result, { state: 'page', libraryId: 102, kind: 'episode',
    offset: 25, totalSize: 150, keys: [512, 513], complete: false });
});

test('conflicting Plex body and header pagination evidence holds', async () => {
  const result = await readPlexSectionKeys({ ...base,
    fetchImpl: withSection(async () => new Response(JSON.stringify(page),
      { status: 200, headers: { 'content-type': 'application/json',
        'X-Plex-Container-Start': '1' } })) });
  assert.deepEqual(result, { state: 'unavailable' });
  const unpaged = await readPlexSectionKeys({ ...base,
    fetchImpl: withSection(async () => Response.json({ MediaContainer: {
      size: 2, librarySectionID: 102, Metadata: page.MediaContainer.Metadata,
    } })) });
  assert.deepEqual(unpaged, { state: 'unavailable' });
});

test('wrong section, wrong kind, shifted offset, duplicate keys and oversized page hold', async () => {
  const cases = [
    { ...page.MediaContainer, librarySectionID: 103 },
    { ...page.MediaContainer, Metadata: [{ ...page.MediaContainer.Metadata[0], type: 'movie' }] },
    { ...page.MediaContainer, offset: 1 },
    { ...page.MediaContainer, Metadata: [page.MediaContainer.Metadata[0], page.MediaContainer.Metadata[0]] },
    { ...page.MediaContainer, size: 25 },
  ];
  for (const container of cases) {
    assert.deepEqual(await readPlexSectionKeys({ ...base,
      fetchImpl: withSection(async () => Response.json({ MediaContainer: container })) }),
    { state: 'unavailable' });
  }
});

test('HTTP errors and byte-cap failures never become an empty successful page', async () => {
  for (const status of [401, 404, 302]) {
    assert.deepEqual(await readPlexSectionKeys({ ...base,
      fetchImpl: withSection(async () => new Response(null, { status })) }),
    { state: 'unavailable' });
  }
  assert.deepEqual(await readPlexSectionKeys({ ...base,
    fetchImpl: withSection(async () => new Response('{}', { headers: { 'content-length': '1000001' } })) }),
  { state: 'unavailable' });
});

test('missing or unsafe advertised type pivots hold without fetching a page', async () => {
  for (const key of [null, 'https://other.example/library/sections/102/all?type=4',
    '/library/sections/103/all?type=4', '/library/sections/102/refresh?type=4',
    '/library/sections/102/all?type=1']) {
    let calls = 0;
    const result = await readPlexSectionKeys({ ...base, fetchImpl: async (url) => {
      calls++;
      assert.equal(url.pathname, '/library/sections/102');
      return Response.json({ MediaContainer: { librarySectionID: 102,
        Directory: key === null ? [] : [{ type: '4', key }] } });
    } });
    assert.deepEqual(result, { state: 'unavailable' });
    assert.equal(calls, 1);
  }
});
