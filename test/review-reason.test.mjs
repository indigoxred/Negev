import assert from 'node:assert/strict';
import test from 'node:test';
import { reviewReasonText } from '../src/web/public/review-reason.mjs';

test('known review reasons read as plain English', () => {
  assert.equal(reviewReasonText('file_plan_mismatch'),
    'The downloaded files do not match the planned episodes');
  assert.equal(reviewReasonText('unrecognized_import_video'),
    'Shoko found a video it could not match');
});

test('unknown reasons fall back to a readable form of the code', () => {
  assert.equal(reviewReasonText('some_new_reason'), 'Some new reason');
  assert.equal(reviewReasonText(''), 'No reason recorded');
  assert.equal(reviewReasonText(undefined), 'No reason recorded');
  assert.equal(reviewReasonText('constructor'), 'Constructor', 'object keys are not treated as known');
});
