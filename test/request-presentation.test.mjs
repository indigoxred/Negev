import assert from 'node:assert/strict';
import test from 'node:test';
import { requestPresentation } from '../src/web/public/request-progress-text.mjs';

const base = { state: 'saved', targetCount: 12,
  publicAvailability: 'unverified', publicVerifiedTargets: 0 };

test('a saved request and an unobserved download do not claim a transfer or ETA', () => {
  assert.deepEqual(requestPresentation(base, 'series'), {
    stage: 'Requested', detail: 'No download is confirmed in progress.',
    note: '', group: 'active',
  });
  assert.deepEqual(requestPresentation({ ...base, state: 'download_unverified' }, 'series'), {
    stage: 'Checking download status',
    detail: 'Negev has requested a download but has not confirmed its current progress.',
    note: '', group: 'active',
  });
});

test('exact public proof gives clear partial and complete coverage', () => {
  assert.deepEqual(requestPresentation({ ...base, state: 'download_unverified',
    publicAvailability: 'verified_recently', publicVerifiedTargets: 6 }, 'series'), {
    stage: 'Partly available', detail: '6 of 12 requested episodes playable in Plex.',
    note: 'Checking download status', group: 'active',
  });
  assert.deepEqual(requestPresentation({ ...base, state: 'saved', targetCount: 1,
    publicAvailability: 'verified_recently', publicVerifiedTargets: 1 }, 'movie'), {
    stage: 'Ready to watch', detail: 'The requested film is playable in Plex.',
    note: '', group: 'completed',
  });
});

test('an Airing watch remains watching after all currently requested episodes arrive', () => {
  assert.deepEqual(requestPresentation({ ...base, state: 'saved', targetCount: 6,
    publicAvailability: 'verified_recently', publicVerifiedTargets: 6 },
  'series', { monitorFuture: true, watchClosed: false }), {
    stage: 'Watching for the next episode',
    detail: 'All 6 currently requested episodes are playable in Plex.',
    note: '', group: 'watching',
  });
  assert.deepEqual(requestPresentation({ ...base, targetCount: 0 },
  'series', { monitorFuture: true, watchClosed: false }), {
    stage: 'Watching for the first episode',
    detail: 'No episode is included in this request yet.',
    note: '', group: 'watching',
  });
});

test('a previously fulfilled request keeps its history when recent Plex proof expires', () => {
  assert.deepEqual(requestPresentation({ ...base, oneTimeAcquisitionComplete: true }, 'series'), {
    stage: 'Completed earlier',
    detail: 'This request was fulfilled, but playback has not been checked recently.',
    note: '', group: 'completed',
  });
  assert.deepEqual(requestPresentation({ ...base, oneTimeAcquisitionComplete: true,
    publicAvailability: 'verified_recently', publicVerifiedTargets: 6 }, 'series'), {
    stage: 'Partly available', detail: '6 of 12 requested episodes playable in Plex.',
    note: 'Completed earlier; the other episodes are not confirmed playable recently.',
    group: 'completed',
  });
});

test('a playable title still exposes an earlier attempt needing owner attention', () => {
  assert.deepEqual(requestPresentation({ ...base, state: 'review_needed', targetCount: 1,
    publicAvailability: 'verified_recently', publicVerifiedTargets: 1 }, 'movie'), {
    stage: 'Ready to watch', detail: 'The requested film is playable in Plex.',
    note: 'An earlier download needs owner review.', group: 'attention',
  });
  assert.deepEqual(requestPresentation({ ...base, state: 'request_interrupted' }, 'series'), {
    stage: 'Needs attention', detail: 'The owner needs to check this request.',
    note: 'A previous check was interrupted.', group: 'attention',
  });
});

test('private file and AniDB checks stay distinct from public playback', () => {
  assert.deepEqual(requestPresentation({ ...base, state: 'partial_private_copy',
    targetCount: 2, privateVerifiedTargets: 1,
    identityCheckPending: true }, 'series'), {
    stage: 'Adding to the library',
    detail: '1 of 2 requested files checked; Plex playback is not confirmed yet.',
    note: 'Another downloaded file still needs identity checking.', group: 'active',
  });
  assert.deepEqual(requestPresentation({ ...base, state: 'release_identity_unverified',
    targetCount: 1 }, 'movie'), {
    stage: 'Checking the download',
    detail: 'The downloaded file has not been confirmed as the requested title yet.',
    note: 'Negev will check again.', group: 'active',
  });
});
