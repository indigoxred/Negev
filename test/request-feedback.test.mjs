import assert from 'node:assert/strict';
import test from 'node:test';
import { requestFailureMessage, savedRequestMessage } from '../src/web/public/request-feedback.mjs';

test('request feedback explains an unverified release date without leaking a reason code', () => {
  assert.equal(requestFailureMessage(new Error('release_state_unknown')),
    'Negev could not confirm when this title starts airing. Please try again when its release date is listed.');
});

test('request feedback explains a changed selection and has a safe generic fallback', () => {
  assert.equal(requestFailureMessage(new Error('invalid_episode_selection')),
    'The episode selection changed. Refresh this title and choose again.');
  assert.equal(requestFailureMessage({ message: 'Already available in Negev’s Library',
    reason: 'already_available' }),
  'This installment is already available in Negev’s Library.');
  assert.equal(requestFailureMessage({ reason: 'title_not_in_cutover' }),
    'Requests for this title are not open yet. Please use Seerr for now.');
  assert.equal(requestFailureMessage(new Error('internal_error')),
    'The request could not be saved. Please try again.');
});

test('saved request feedback distinguishes a pending release schedule', () => {
  assert.equal(savedRequestMessage({ state: 'pending', waitingFor: 'release_schedule' }),
    'Request saved. Negev will watch for the release schedule and first episode. Follow it under My Requests.');
  assert.equal(savedRequestMessage({ state: 'pending', requestId: 7,
    waitingFor: 'release_schedule' }),
  'Request #7 saved. Negev will watch for the release schedule and first episode. Follow it under My Requests.');
  assert.equal(savedRequestMessage({ state: 'held', requestId: 13 }),
    'Request #13 saved. View its progress under My Requests.');
});
