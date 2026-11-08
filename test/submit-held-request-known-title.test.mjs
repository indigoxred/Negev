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

test('a recently verified whole installment is held before a duplicate request is saved', async () => {
  let saved = 0;
  const detail = { state: 'details', anidbId: 42, title: 'Known film',
    kind: 'movie', restricted: false, complete: true, page: 1, total: 1,
    nextPage: null, airDate: '2020-01-01', endDate: '2020-01-01',
    episodeCount: 1, episodes: [{ id: 99, number: 1, type: 'Episode',
      title: 'Film', airDate: '2020-01-01' }] };
  const submit = createHeldRequestSubmitter({
    confirmKnownTitle: async () => true,
    loadDetail: async () => detail,
    recentlyAvailable: ({ episodeId }) => episodeId === 99,
    ledger: { findSubmission: () => null, submit: () => { saved++; } },
    now: () => 1, today: () => '2026-11-08',
  });
  assert.deepEqual(await submit({ requesterId: 1, anidbId: 42,
    scope: 'installment', requestKey: 'available' }),
  { state: 'held', reason: 'already_available' });
  assert.equal(saved, 0);
});
