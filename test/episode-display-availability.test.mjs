import assert from 'node:assert/strict';
import test from 'node:test';
import { episodeDisplayAvailability } from
  '../src/availability/episode-display-availability.mjs';

test('a playable alternate-card file keeps an honest episode note', () => {
  assert.deepEqual(episodeDisplayAvailability({ direct: 'unknown',
    title: 'unknown', file: { state: 'available',
      presentation: 'alternate_card' } }),
  { availability: 'available', availabilityNote: 'alternate_card' });
});

test('an exact public card removes the alternate-card note', () => {
  assert.deepEqual(episodeDisplayAvailability({ direct: 'available',
    title: 'unknown', file: { state: 'available',
      presentation: 'alternate_card' } }),
  { availability: 'available' });
  assert.deepEqual(episodeDisplayAvailability({ direct: 'unknown',
    title: 'unknown', file: { state: 'available' } }),
  { availability: 'available' });
});

test('a direct alternate-card status keeps its playable explanation', () => {
  assert.deepEqual(episodeDisplayAvailability({ direct: 'available',
    directPresentation: 'alternate_card', title: 'unknown',
    file: { state: 'unknown' } }),
  { availability: 'available', availabilityNote: 'alternate_card' });
  assert.deepEqual(episodeDisplayAvailability({ direct: 'available',
    title: 'unknown', file: { state: 'unknown' } }),
  { availability: 'available' });
});

test('stale and missing proofs do not claim current playability', () => {
  assert.deepEqual(episodeDisplayAvailability({ direct: 'unknown',
    title: 'unknown', file: { state: 'previously_available',
      presentation: 'alternate_card' } }),
  { availability: 'previously_available' });
  assert.deepEqual(episodeDisplayAvailability({ direct: 'unknown',
    title: 'unknown', file: { state: 'unknown' } }),
  { availability: 'unknown' });
});
