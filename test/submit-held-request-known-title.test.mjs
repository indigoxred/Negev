import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHeldRequestSubmitter } from '../src/requests/submit-held-request.mjs';

test('request submission checks validated catalogue after observed search expires', async () => {
  const checked = [];
  const submit = createHeldRequestSubmitter({
    titleRegistry: { isKnownTitle: () => false },
    confirmKnownTitle: async ({ anidbId }) => {
      checked.push(anidbId);
      return anidbId === 42;
    },
    loadDetail: async ({ anidbId }) => ({ state: 'detail_pending', anidbId }),
    ledger: { findSubmission: () => null, submit: () => {
      throw new Error('Pending detail must not submit');
    } },
    now: () => 1, today: () => '2026-11-03',
  });
  const command = { requesterId: 1, scope: 'installment', requestKey: 'valid' };
  assert.deepEqual(await submit({ ...command, anidbId: 42 }),
    { state: 'held', reason: 'detail_pending' });
  assert.deepEqual(await submit({ ...command, anidbId: 99 }),
    { state: 'held', reason: 'unknown_title' });
  assert.deepEqual(checked, [42, 99]);
});
