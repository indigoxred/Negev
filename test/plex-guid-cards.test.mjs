import assert from 'node:assert/strict';
import test from 'node:test';
import { readPlexGuidCards } from '../src/availability/plex-guid-cards.mjs';

const base = { baseUrl: 'http://plex:32400/', token: 'synthetic',
  libraryId: 102, kind: 'episode',
  guid: 'tv.plex.agents.custom.shoko://episode/e555' };
const page = (metadata, totalSize = metadata.length) => Response.json({
  MediaContainer: { librarySectionID: 102, offset: 0, size: metadata.length,
    totalSize, Metadata: metadata },
});

test('returns only exact scoped positive episode cards from a GUID filter', async () => {
  const result = await readPlexGuidCards({ ...base, fetchImpl: async (url, init) => {
    assert.equal(url.pathname, '/library/sections/102/all');
    assert.equal(url.searchParams.get('type'), '4');
    assert.equal(url.searchParams.get('guid'), base.guid);
    assert.equal(init.headers['X-Plex-Container-Size'], '10');
    assert.equal(init.redirect, 'manual');
    return page([{ ratingKey: 500, librarySectionID: 102,
      type: 'episode', guid: base.guid }]);
  } });
  assert.deepEqual(result, { state: 'cards', cards: [{ libraryId: 102,
    ratingKey: 500, kind: 'episode' }], complete: true });
});

test('an empty filtered result is only no-match evidence, never absence proof', async () => {
  assert.deepEqual(await readPlexGuidCards({ ...base,
    fetchImpl: async () => page([]) }),
  { state: 'cards', cards: [], complete: true });
});

test('accepts a scoped container when Plex omits librarySectionID on its item', async () => {
  const result = await readPlexGuidCards({ ...base,
    fetchImpl: async () => page([{ ratingKey: 500,
      type: 'episode', guid: base.guid }]) });
  assert.deepEqual(result, { state: 'cards', cards: [{ libraryId: 102,
    ratingKey: 500, kind: 'episode' }], complete: true });
});

test('an explicit zero-item GUID result may omit Metadata', async () => {
  const result = await readPlexGuidCards({ ...base,
    fetchImpl: async () => Response.json({ MediaContainer: {
      librarySectionID: 102, offset: 0, size: 0, totalSize: 0,
    } }) });
  assert.deepEqual(result, { state: 'cards', cards: [], complete: true });
});

test('ignored filters, mixed libraries, and truncated pages hold', async () => {
  for (const response of [
    page([{ ratingKey: 500, librarySectionID: 102,
      type: 'episode', guid: 'other://episode/1' }]),
    page([{ ratingKey: 500, librarySectionID: 103,
      type: 'episode', guid: base.guid }]),
    page([{ ratingKey: 500, librarySectionID: 102,
      type: 'episode', guid: base.guid }], 11),
  ]) {
    assert.deepEqual(await readPlexGuidCards({ ...base,
      fetchImpl: async () => response.clone() }), { state: 'unavailable' });
  }
});

test('movie card may carry exact TMDB ID in its secondary GUIDs', async () => {
  const result = await readPlexGuidCards({ ...base, libraryId: 9,
    kind: 'movie', guid: 'tmdb://123', fetchImpl: async (url) => {
      assert.equal(url.searchParams.get('type'), '1');
      return Response.json({ MediaContainer: { librarySectionID: 9,
        offset: 0, size: 1, totalSize: 1, Metadata: [{ ratingKey: 800,
          librarySectionID: 9, type: 'movie', guid: 'plex://movie/abc',
          Guid: [{ id: 'tmdb://123' }] }] } });
    } });
  assert.deepEqual(result, { state: 'cards', cards: [{ libraryId: 9,
    ratingKey: 800, kind: 'movie' }], complete: true });
});
