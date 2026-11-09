import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConsumerRoute, titleRoute, searchRoute,
  seasonRoute, browseReturnDestination } from '../src/web/public/consumer-route.mjs';

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

test('season and page survive reload and Back/Forward without accepting arbitrary filters', () => {
  assert.deepEqual(parseConsumerRoute(seasonRoute(0, 'ALL')),
    { page: 'discover', anidbId: null, query: '', year: 0,
      season: 'ALL', after: 0 });
  const route = seasonRoute(2026, 'FALL', 12);
  assert.equal(route, '#/discover?year=2026&season=FALL&after=12');
  assert.deepEqual(parseConsumerRoute(route), { page: 'discover', anidbId: null,
    query: '', year: 2026, season: 'FALL', after: 12 });
  assert.deepEqual(parseConsumerRoute('#/discover?year=2026&season=FALL&admin=1'),
    { page: 'discover', anidbId: null, query: '' });
  const filtered = seasonRoute(2026, 'FALL', 12,
    { kind: 'movies', tag: 'sci-fi' });
  assert.equal(filtered,
    '#/discover?year=2026&season=FALL&after=12&kind=movies&tag=sci-fi');
  assert.deepEqual(parseConsumerRoute(filtered), { page: 'discover', anidbId: null,
    query: '', year: 2026, season: 'FALL', after: 12,
    kind: 'movies', tag: 'sci-fi' });
  assert.equal(seasonRoute(2026, 'FALL', 0,
    { tag: 'action,fantasy' }), '#/discover?year=2026&season=FALL&tag=action%2Cfantasy');
  assert.deepEqual(parseConsumerRoute('#/discover?year=2026&season=FALL&kind=unsafe'),
    { page: 'discover', anidbId: null, query: '' });
});

test('title back link returns to the actual catalogue view', () => {
  assert.deepEqual(browseReturnDestination(parseConsumerRoute(
    '#/discover?q=tensei+slime')),
  { href: '#/discover?q=tensei+slime', label: 'Discover' });
  assert.deepEqual(browseReturnDestination(parseConsumerRoute(
    '#/discover?year=2025&season=ALL&kind=movies')),
  { href: '#/discover?year=2025&season=ALL&kind=movies', label: 'Discover' });
  assert.deepEqual(browseReturnDestination(parseConsumerRoute('#/airing')),
    { href: '#/airing', label: 'Airing' });
  assert.deepEqual(browseReturnDestination(parseConsumerRoute('#/library')),
    { href: '#/library', label: 'Library' });
  assert.equal(browseReturnDestination(parseConsumerRoute('#/title/4158')), null);
});
