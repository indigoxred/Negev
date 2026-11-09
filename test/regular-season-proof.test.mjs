import assert from 'node:assert/strict';
import test from 'node:test';
import { countVerifiedRegularEpisodes } from
  '../src/availability/regular-season-proof.mjs';

test('season count intersects current proof IDs with regular episode IDs', () => {
  assert.deepEqual(countVerifiedRegularEpisodes({
    regularIds: [11, 12, 13], verifiedIds: new Set([11, 99]),
  }), { verified: 1, total: 3 });
  assert.deepEqual(countVerifiedRegularEpisodes({
    regularIds: [11, 12], verifiedIds: new Set([99]),
  }), { verified: 0, total: 2 });
  assert.equal(countVerifiedRegularEpisodes({
    regularIds: null, verifiedIds: new Set([11]),
  }), null);
});
