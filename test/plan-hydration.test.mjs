import assert from 'node:assert/strict';
import test from 'node:test';
import { planHydration } from '../src/catalogue/plan-hydration.mjs';

const nowMs = 1_000_000_000;
const input = { anidbId: 1234, titleKnown: true, detailState: 'detail_pending', nowMs };

test('admits one known, missing title with no active refresh or recent attempt', () => {
  assert.deepEqual(planHydration(input), { state: 'admit' });
});

test('a ready or unavailable detail never triggers a refresh', () => {
  assert.deepEqual(planHydration({ ...input, detailState: 'details' }),
    { state: 'no_refresh', reason: 'details_present' });
  assert.deepEqual(planHydration({ ...input, detailState: 'unavailable' }),
    { state: 'defer', reason: 'detail_unavailable' });
  assert.deepEqual(planHydration({ ...input, titleKnown: false }),
    { state: 'defer', reason: 'unknown_title' });
});

test('holds while another title refresh is still active', () => {
  assert.deepEqual(planHydration({ ...input, activeRefreshes: 1 }),
    { state: 'defer', reason: 'active_refresh' });
});

test('holds a repeated title for a full day after submission', () => {
  assert.deepEqual(planHydration({ ...input, lastTitleAttemptMs: nowMs - 1_000 }),
    { state: 'defer', reason: 'title_cooldown', retryAtMs: nowMs - 1_000 + 86_400_000 });
  assert.deepEqual(planHydration({ ...input, lastTitleAttemptMs: nowMs - 86_400_000 }),
    { state: 'admit' });
});

test('spaces different titles and caps daily submissions', () => {
  assert.deepEqual(planHydration({ ...input, lastGlobalAttemptMs: nowMs - 10_000 }),
    { state: 'defer', reason: 'global_cooldown', retryAtMs: nowMs + 50_000 });
  assert.deepEqual(planHydration({ ...input, lastGlobalAttemptMs: nowMs - 60_000 }),
    { state: 'admit' });
  assert.deepEqual(planHydration({ ...input, attempts24h: 30 }),
    { state: 'defer', reason: 'daily_budget' });
});

test('future timestamps or malformed counters fail closed', () => {
  assert.deepEqual(planHydration({ ...input, lastTitleAttemptMs: nowMs + 1 }),
    { state: 'defer', reason: 'clock_skew' });
  assert.throws(() => planHydration({ ...input, attempts24h: -1 }), TypeError);
  assert.throws(() => planHydration({ ...input, anidbId: 0 }), TypeError);
});
