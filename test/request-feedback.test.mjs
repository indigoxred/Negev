import assert from 'node:assert/strict';
import test from 'node:test';
import { requestFailureMessage, savedRequestMessage } from '../src/web/public/request-feedback.mjs';

test('request feedback explains an unverified release date without leaking a reason code', () => {
  assert.equal(requestFailureMessage(new Error('release_state_unknown')),
    'Negev could not confirm this title’s release timing from catalogue dates. Please try again shortly.');
});

test('request feedback explains a changed selection and has a safe generic fallback', () => {
  assert.equal(requestFailureMessage(new Error('invalid_episode_selection')),
    'The episode selection changed. Refresh this title and choose again.');
  assert.equal(requestFailureMessage({ message: 'Already available in Negev’s Library',
    reason: 'already_available' }),
  'This installment is already available in Negev’s Library.');
  assert.equal(requestFailureMessage({ reason: 'title_not_in_cutover' }),
    'Anime requests for this title are temporarily unavailable in Negev. Please try again later.');
  assert.equal(requestFailureMessage({ reason: 'already_monitored_elsewhere' }),
    'Future episodes are already monitored. No second request is needed.');
  assert.equal(requestFailureMessage(new Error('internal_error')),
    'The request could not be saved. Please try again.');
});

test('saved request feedback explains uncertain catalogue dates without assuming a future release', () => {
  assert.equal(savedRequestMessage({ state: 'pending', waitingFor: 'release_schedule' }),
    'Request saved. Negev is checking catalogue dates and episodes. No download has started. Follow it under My Requests.');
  assert.equal(savedRequestMessage({ state: 'pending', requestId: 7,
    waitingFor: 'release_schedule' }),
  'Request #7 saved. Negev is checking catalogue dates and episodes. No download has started. Follow it under My Requests.');
  assert.equal(savedRequestMessage({ state: 'held', requestId: 13 }),
    'Request #13 saved. View its progress under My Requests.');
  assert.equal(savedRequestMessage({ state: 'held', requestId: 13,
    reason: 'already_monitored' }),
  'Future episodes are already monitored by your request #13. View it under My Requests.');
});

test('paused watch message explains the administrator resolution without naming its owner',()=>{
 assert.match(requestFailureMessage({reason:'watch_paused_elsewhere'}),/paused.*administrator/i);
});
