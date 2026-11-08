import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detailRefreshDelay } from '../src/web/public/detail-refresh.mjs';

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
