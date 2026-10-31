import assert from 'node:assert/strict';
import test from 'node:test';
import { recentPublicCoverage } from '../src/availability/recent-public-coverage.mjs';

test('request progress unites direct import and title checks without double counting', () => {
  assert.deepEqual(recentPublicCoverage({ episodeIds: [1001, 1002, 1003],
    directIds: [1001, 1002], titleIds: [1002, 1003, 9999] }),
  { verifiedTargets: 3, targetCount: 3 });
  assert.deepEqual(recentPublicCoverage({ episodeIds: [1001, 1002],
    directIds: [], titleIds: [1002] }),
  { verifiedTargets: 1, targetCount: 2 });
});
