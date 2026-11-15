import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as franchise from '../src/web/public/franchise-explorer.mjs';
import * as selection from '../src/web/public/season-request-selection.mjs';

test('related installment labels use the full season or film proof', () => {
  assert.equal(typeof selection.relatedAvailabilityText, 'function');
  const label = selection.relatedAvailabilityText;
  assert.equal(label({ state: 'details', kind: 'series',
    regularSeason: { total: 12, verified: 12 }, episodes: [], nextPage: null }),
  'Available · 12/12');
  assert.equal(label({ state: 'details', kind: 'series',
    regularSeason: { total: 12, verified: 5 }, episodes: [], nextPage: null }),
  'Partial · 5/12');
  assert.equal(label({ state: 'details', kind: 'movie', nextPage: null,
    episodes: [{ type: 'Episode', availability: 'available' }] }),
  'Available · 1/1');
  assert.equal(label({ state: 'detail_pending' }), 'Availability unconfirmed');
});

test('related detail reads coalesce and never exceed three simultaneous reads', async () => {
  assert.equal(typeof franchise.createRelatedDetailCache, 'function');
  let active = 0;
  let peak = 0;
  const release = [];
  const cache = franchise.createRelatedDetailCache({ read: (id) => {
    active++;
    peak = Math.max(peak, active);
    return new Promise((resolve) => release.push(() => {
      active--;
      resolve({ state: 'details', anidbId: id });
    }));
  } });
  const first = cache.get(1);
  assert.strictEqual(cache.get(1), first);
  const pending = [first, ...[2, 3, 4, 5].map((id) => cache.get(id))];
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, 3);
  release.splice(0, 3).forEach((done) => done());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, 2);
  release.splice(0).forEach((done) => done());
  await Promise.all(pending);
  assert.equal(peak, 3);
  assert.deepEqual(cache.peek(4), { state: 'details', anidbId: 4 });
});

test('a failed related read stays unconfirmed and can be retried', async () => {
  let reads = 0;
  const cache = franchise.createRelatedDetailCache({ read: async (id) => {
    reads++;
    if (reads === 1) throw new Error('Temporary outage');
    return { state: 'details', anidbId: id, kind: 'series',
      regularSeason: { total: 1, verified: 1 }, episodes: [], nextPage: null };
  } });
  assert.deepEqual(await cache.get(42),
    { state: 'detail_unavailable', anidbId: 42 });
  assert.equal(selection.relatedAvailabilityText(cache.peek(42)),
    'Availability unconfirmed');
  assert.equal((await cache.get(42)).state, 'details');
  assert.equal(reads, 2);
});

test('large franchises can check cards beyond the fifty-result cache', async () => {
  const cache = franchise.createRelatedDetailCache({ read: async (id) =>
    ({ state: 'details', anidbId: id }) });
  for (let id = 1; id <= 60; id++) {
    assert.equal((await cache.get(id)).state, 'details');
  }
  assert.deepEqual(cache.peek(60), { state: 'details', anidbId: 60 });
  assert.equal(cache.peek(1), null);
});
