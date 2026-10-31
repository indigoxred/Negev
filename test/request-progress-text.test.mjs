import assert from 'node:assert/strict';
import test from 'node:test';
import { progressText } from '../src/web/public/request-progress-text.mjs';

test('public Plex proof remains visible alongside an earlier rejected download', () => {
  const progress = { state: 'review_needed', publicAvailability: 'verified_recently',
    publicVerifiedTargets: 1, targetCount: 1 };
  assert.equal(progressText(progress, 'movie'),
    'All requested film targets checked playable in Plex recently · Earlier download needs review');
  assert.equal(progressText({ ...progress, publicVerifiedTargets: 1, targetCount: 2 }, 'series'),
    '1/2 requested episodes checked playable in Plex recently · Earlier download needs review');
});

test('an unverified request still shows review and singular private copy wording', () => {
  assert.equal(progressText({ state: 'review_needed', publicAvailability: 'unverified' }, 'series'),
    'Needs owner review');
  assert.equal(progressText({ state: 'partial_private_copy',
    publicAvailability: 'unverified', privateVerifiedTargets: 1, targetCount: 2 }, 'series'),
  '1/2 episode targets have a recorded private copy · Plex unverified');
});
