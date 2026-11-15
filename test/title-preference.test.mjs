import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detailOriginalTitle } from '../src/web/public/title-preference.mjs';

test('detail keeps the AniDB main title when another detail source uses English', () => {
  assert.equal(detailOriginalTitle(
    { title: 'Chainsaw Man: Reze-hen' },
    { title: 'Chainsaw Man the Movie: Reze Arc',
      originalTitle: 'Chainsaw Man: Reze-hen' }),
  'Chainsaw Man: Reze-hen');
});

test('detail falls back to the catalogue card before an English detail title', () => {
  assert.equal(detailOriginalTitle(
    { title: 'Sousou no Frieren (2027)' },
    { title: 'Frieren: Beyond Journey\'s End (2027)' }),
  'Sousou no Frieren (2027)');
});

test('direct title links never leave the placeholder as a title', () => {
  assert.equal(detailOriginalTitle(
    { title: 'Anime 123' },
    { title: 'English detail', originalTitle: 'Original main title' }),
  'Original main title');
});
