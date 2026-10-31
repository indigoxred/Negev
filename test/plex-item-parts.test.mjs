import assert from 'node:assert/strict';
import test from 'node:test';
import { readPlexItemParts } from '../src/availability/plex-item-parts.mjs';

const item = { ratingKey: '512', type: 'episode', librarySectionID: 102,
  guid: 'tv.plex.agents.custom.shoko://episode/e555',
  grandparentGuid: 'tv.plex.agents.custom.shoko://show/99',
  Media: [{ id: 77, Part: [{ id: 88, file: '/source-pure/Anime/Show/01.mkv', size: 5 }] }] };
const response = (metadata = item) => Response.json({ MediaContainer: {
  size: 1, Metadata: [metadata],
} });
const input = { baseUrl: 'http://plex:32400/', token: 'private-test-token',
  ratingKey: 512, expectedType: 'episode', libraryId: 102 };

test('reads one exact public Plex episode and its file parts without a scan', async () => {
  let calls = 0;
  const result = await readPlexItemParts({ ...input, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url.pathname, '/library/metadata/512');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers['X-Plex-Token'], 'private-test-token');
    assert.equal(options.headers.Accept, 'application/json');
    return response();
  } });
  assert.equal(calls, 1);
  assert.deepEqual(result, { state: 'ok', complete: true, parts: [
    { partId: 88, plexPath: '/source-pure/Anime/Show/01.mkv', size: 5,
      libraryId: 102, cardType: 'episode', itemGuid: item.guid,
      showGuid: item.grandparentGuid, externalGuids: [] },
  ] });
});

test('a wrong item, section, or type cannot supply availability evidence', async () => {
  for (const changed of [
    { ...item, ratingKey: '513' },
    { ...item, librarySectionID: 130 },
    { ...item, type: 'movie' },
  ]) {
    assert.deepEqual(await readPlexItemParts({ ...input,
      fetchImpl: async () => response(changed) }), { state: 'unavailable' });
  }
});

test('a missing or malformed Part is incomplete rather than proof of absence', async () => {
  for (const changed of [
    { ...item, Media: [] },
    { ...item, Media: [{ Part: [{ id: 88, file: '../episode.mkv', size: 5 }] }] },
    { ...item, Media: [{ Part: [{ id: 88, file: '/video.mkv', size: 0 }] }] },
  ]) {
    assert.deepEqual(await readPlexItemParts({ ...input,
      fetchImpl: async () => response(changed) }), { state: 'unavailable' });
  }
});

test('missing record, denied access, redirect and oversized body do not imply no file', async () => {
  for (const status of [404, 401, 302]) {
    const result = await readPlexItemParts({ ...input,
      fetchImpl: async () => new Response(null, { status }) });
    assert.deepEqual(result, status === 404 ? { state: 'not_found' } : { state: 'unavailable' });
  }
  const oversized = new Response('{}', { headers: { 'content-length': '2000001' } });
  assert.deepEqual(await readPlexItemParts({ ...input, fetchImpl: async () => oversized }),
    { state: 'unavailable' });
});

test('supports a movie and multiple physical versions without title matching', async () => {
  const movie = { ...item, type: 'movie', librarySectionID: 9, Media: [
    { Part: [{ id: 1, file: '/movies/a.mkv', size: 9 }] },
    { Part: [{ id: 2, file: '/movies/b.mkv', size: 10 }] },
  ] };
  const result = await readPlexItemParts({ ...input, expectedType: 'movie', libraryId: 9,
    fetchImpl: async () => response(movie) });
  assert.deepEqual(result.parts.map((part) => part.partId), [1, 2]);
});
