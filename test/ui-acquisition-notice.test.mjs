import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acquisitionNotice } from
  '../src/web/public/acquisition-notice.mjs';

test('review holds do not tell users acquisition is disabled or paused', () => {
  assert.equal(acquisitionNotice('waiting_with_review'),
    'Automatic acquisition is enabled. Some items need review; other requests continue.');
});

test('disabled and recovery states remain distinct', () => {
  assert.equal(acquisitionNotice('disabled'), 'Automatic acquisition is off.');
  assert.equal(acquisitionNotice('reconciliation_held'),
    'Automatic acquisition is paused while its safety checks recover.');
  assert.equal(acquisitionNotice('unknown'),
    'Automatic acquisition status is unavailable.');
});
