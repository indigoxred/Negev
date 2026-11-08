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

test('a fully aired and available series without an end date is not watched again', async () => {
  let saved = 0;
  const detail = { state: 'details', anidbId: 44, title: 'Completed installment',
    kind: 'series', restricted: false, complete: true, page: 1, total: 2,
    nextPage: null, airDate: '2026-10-01', endDate: null,
    episodeCount: 2, episodes: [1, 2].map((number) => ({
      id: 300 + number, number, type: 'Episode', title: `Episode ${number}`,
      airDate: `2026-10-0${number}` })) };
  const submit = createHeldRequestSubmitter({
    confirmKnownTitle: async () => true, loadDetail: async () => detail,
    recentlyAvailable: async () => true,
    ledger: { findSubmission: () => null, submit: () => { saved++; } },
    now: () => 1, today: () => '2026-11-08',
  });
  assert.deepEqual(await submit({ requesterId: 1, anidbId: 44,
    scope: 'installment', requestKey: 'already-here' }),
  { state: 'held', reason: 'already_available' });
  assert.equal(saved, 0);
});

test('a partial installment request saves only episodes without recent playable proof', async () => {
  const detail = { state: 'details', anidbId: 42, title: 'Three episode show',
    kind: 'series', restricted: false, complete: true, page: 1, total: 3,
    nextPage: null, airDate: '2020-01-01', endDate: '2020-01-15',
    episodeCount: 3, episodes: [1, 2, 3].map((number) => ({
      id: 100 + number, number, type: 'Episode', title: `Part ${number}`,
      airDate: `2020-01-${String(number).padStart(2, '0')}` })) };
  let saved;
  const submit = createHeldRequestSubmitter({
    confirmKnownTitle: async () => true,
    loadDetail: async () => detail,
    recentlyAvailable: ({ episodeId }) => episodeId !== 103,
    ledger: { findSubmission: () => null, submit: (input) => {
      saved = input;
      return { state: 'saved' };
    } },
    now: () => 1, today: () => '2026-11-08',
  });
  assert.deepEqual(await submit({ requesterId: 1, anidbId: 42,
    scope: 'installment', requestKey: 'missing-one' }), { state: 'saved' });
  assert.deepEqual(saved.intent.episodeIds, [103]);
  assert.equal(saved.intent.monitorFuture, false);
});

test('an Airing request can watch future episodes without reacquiring verified current ones', async () => {
  const detail = { state: 'details', anidbId: 43, title: 'Airing show',
    kind: 'series', restricted: false, complete: true, page: 1, total: 1,
    nextPage: null, airDate: '2026-11-01', endDate: null,
    episodeCount: 12, episodes: [{ id: 201, number: 1, type: 'Episode',
      title: 'First', airDate: '2026-11-01' }] };
  let saved;
  const submit = createHeldRequestSubmitter({
    confirmKnownTitle: async () => true,
    loadDetail: async () => detail,
    recentlyAvailable: async () => true,
    ledger: { findSubmission: () => null, submit: (input) => {
      saved = input;
      return { state: 'saved' };
    } },
    now: () => 1, today: () => '2026-11-08',
  });
  assert.deepEqual(await submit({ requesterId: 1, anidbId: 43,
    scope: 'installment', requestKey: 'watch-future' }), { state: 'saved' });
  assert.deepEqual(saved.intent.episodeIds, []);
  assert.equal(saved.intent.monitorFuture, true);
});
