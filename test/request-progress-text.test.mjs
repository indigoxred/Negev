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

test('partial public availability also shows an active acquisition stage', () => {
  assert.equal(progressText({ state: 'download_unverified',
    publicAvailability: 'verified_recently', publicVerifiedTargets: 1,
    targetCount: 12 }, 'series'),
  '1/12 requested episodes checked playable in Plex recently · Download requested · completion unverified');
  assert.equal(progressText({ state: 'private_copy_recorded',
    publicAvailability: 'verified_recently', publicVerifiedTargets: 1,
    targetCount: 2 }, 'series'),
  '1/2 requested episodes checked playable in Plex recently · Files verified privately · Shoko import unverified');
});

test('an unverified request still shows review and singular private copy wording', () => {
  assert.equal(progressText({ state: 'review_needed', publicAvailability: 'unverified' }, 'series'),
    'Needs owner review');
  assert.equal(progressText({ state: 'partial_private_copy',
    publicAvailability: 'unverified', privateVerifiedTargets: 1, targetCount: 2 }, 'series'),
  '1/2 episode targets have a recorded private copy · Plex unverified');
});

test('a future-only Airing watch explains why no download is recorded', () => {
  assert.equal(progressText({ state: 'saved', targetCount: 0,
    publicAvailability: 'unverified' }, 'series'),
  'Watching for the first aired episode');
});

test('one-time completion remains historical when current Plex proof expires', () => {
  assert.equal(progressText({ state: 'saved', targetCount: 12,
    publicAvailability: 'unverified', oneTimeAcquisitionComplete: true }, 'series'),
  'One-time request finished after all episodes were checked playable in Plex · Current playback not checked recently');
  assert.equal(progressText({ state: 'review_needed', targetCount: 1,
    publicAvailability: 'unverified', oneTimeAcquisitionComplete: true }, 'movie'),
  'One-time request finished after all film targets were checked playable in Plex · Current playback not checked recently · Earlier download needs review');
});
