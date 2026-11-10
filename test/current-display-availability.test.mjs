import assert from 'node:assert/strict';
import test from 'node:test';
import { currentDisplayAvailability } from
  '../src/availability/current-display-availability.mjs';

test('a current exact file proof survives an inconclusive live lookup', () => {
  assert.deepEqual(currentDisplayAvailability({
    live: { state: 'unknown', reason: 'evidence_incomplete' },
    file: { state: 'available' }, hasShokoFile: true,
  }), { state: 'available' });
  assert.deepEqual(currentDisplayAvailability({
    live: { state: 'unknown' },
    file: { state: 'available', presentation: 'alternate_card' },
    hasShokoFile: true,
  }), { state: 'available', presentation: 'alternate_card' });
});

test('stale proof or changed Shoko identity cannot become available', () => {
  for (const file of [{ state: 'previously_available' }, { state: 'unknown' }]) {
    assert.deepEqual(currentDisplayAvailability({ live: { state: 'unknown' },
      file, hasShokoFile: true }), { state: 'unknown' });
  }
  assert.deepEqual(currentDisplayAvailability({ live: { state: 'unknown' },
    file: { state: 'available' }, hasShokoFile: false }), { state: 'unknown' });
  assert.deepEqual(currentDisplayAvailability({ live: { state: 'available' },
    file: { state: 'unknown' }, hasShokoFile: true }), { state: 'available' });
});
