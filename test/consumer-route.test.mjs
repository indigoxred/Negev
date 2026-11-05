import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConsumerRoute, titleRoute, searchRoute } from '../src/web/public/consumer-route.mjs';

test('consumer routes use stable URLs for all main pages and exact AniDB title IDs', () => {
  for (const page of ['discover', 'airing', 'library', 'requests', 'admin']) {
    assert.deepEqual(parseConsumerRoute(`#/${page}`), { page, anidbId: null, query: '' });
  }
  assert.deepEqual(parseConsumerRoute('#/title/4158'),
    { page: 'title', anidbId: 4158, query: '' });
  assert.equal(titleRoute(4158), '#/title/4158');
  assert.deepEqual(parseConsumerRoute('#/title/4158?x=1'),
    { page: 'discover', anidbId: null, query: '' });
  assert.deepEqual(parseConsumerRoute('#/title/0'),
    { page: 'discover', anidbId: null, query: '' });
});

test('search query survives reload and Back/Forward without permitting arbitrary routes', () => {
  const hash = searchRoute('  The Garden of Words ');
  assert.equal(hash, '#/discover?q=The+Garden+of+Words');
  assert.deepEqual(parseConsumerRoute(hash),
    { page: 'discover', anidbId: null, query: 'The Garden of Words' });
  assert.deepEqual(parseConsumerRoute('#/totally-unknown'),
    { page: 'discover', anidbId: null, query: '' });
  assert.deepEqual(parseConsumerRoute('#/discover?q=' + 'x'.repeat(121)),
    { page: 'discover', anidbId: null, query: '' });
});
