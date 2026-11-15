import assert from 'node:assert/strict';
import test from 'node:test';
import { trackingAction, changeTrackedIds } from '../src/web/public/airing-tracking-controls.mjs';

test('tracking actions preserve other titles and the selected Airing preset', () => {
  const preferences = { mode: 'library', trackedAnidbIds: [11, 19] };
  assert.deepEqual(changeTrackedIds(preferences, 12),
    { mode: 'library', trackedAnidbIds: [11, 19, 12] });
  assert.deepEqual(changeTrackedIds(preferences, 19),
    { mode: 'library', trackedAnidbIds: [11] });
  assert.deepEqual(preferences.trackedAnidbIds, [11, 19]);
  assert.equal(trackingAction(preferences, 19), 'Stop tracking');
  assert.equal(trackingAction(preferences, 12), 'Track this title');
  assert.equal(trackingAction(null, 12), 'Loading tracking…');
});
