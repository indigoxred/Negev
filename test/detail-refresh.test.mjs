import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detailRefreshDelay, detailHydrationFollowup } from '../src/web/public/detail-refresh.mjs';

test('pending detail refresh stays below the title read rate limit', () => {
  const reads = [0];
  for (let attempt = 0; attempt < 6; attempt++) {
    const delay = detailRefreshDelay(attempt);
    assert.ok(delay >= 15_000);
    reads.push(reads.at(-1) + delay);
  }
  assert.ok(reads.filter((time) => time < 60_000).length <= 5);
});

test('pending detail refresh slows down and is bounded', () => {
  assert.equal(detailRefreshDelay(0), 15_000);
  assert.equal(detailRefreshDelay(1), 20_000);
  assert.equal(detailRefreshDelay(2), 30_000);
  assert.equal(detailRefreshDelay(20), 30_000);
  assert.throws(() => detailRefreshDelay(-1), TypeError);
});

test('a deferred Shoko refresh retries dispatch, while an accepted refresh only polls', () => {
  assert.deepEqual(detailHydrationFollowup({ state: 'pending', reason: 'global_cooldown' }, 0),
    { state: 'retry', delayMs: 60_000 });
  assert.deepEqual(detailHydrationFollowup({ state: 'pending', reason: 'active_refresh' }, 1),
    { state: 'retry', delayMs: 60_000 });
  assert.deepEqual(detailHydrationFollowup({ state: 'pending', reason: 'refresh_queued' }, 0),
    { state: 'poll', delayMs: 15_000 });
  assert.deepEqual(detailHydrationFollowup({ state: 'pending', reason: 'title_cooldown' }, 1),
    { state: 'poll', delayMs: 20_000 });
  assert.deepEqual(detailHydrationFollowup({ state: 'detail_ready' }, 0),
    { state: 'ready' });
  assert.deepEqual(detailHydrationFollowup({ state: 'pending', reason: 'daily_budget' }, 0),
    { state: 'stop' });
  assert.deepEqual(detailHydrationFollowup({ state: 'pending', reason: 'refresh_queued' }, 5),
    { state: 'stop' });
});
