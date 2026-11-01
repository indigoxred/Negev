import assert from 'node:assert/strict';
import test from 'node:test';
import { listOperationalReview } from '../src/acquisition/operational-review.mjs';

test('combines terminal import holds and wrong-file rejections without exposing hashes', () => {
  const acquisitions = {
    listRejectedNeedsReview: () => [{ attemptId: 1, requestId: 7,
      anidbId: 42, reason: 'file_wrong_identity', observedMs: 100 }],
    getAttempt: (id) => [2, 3, 4].includes(id) ? { id,
      requestId: id + 6, anidbId: id + 41,
      torrentHash: 'secret' } : null,
  };
  const publishQueue = { listReviewNeeded: () => [{ attemptId: 2,
    reason: 'identity_changed', checkedMs: 200 }] };
  const startQueue = { listReviewNeeded: () => [{ attemptId: 3,
    reason: 'provider_unavailable', checkedMs: 300 }] };
  const completionQueue = { listReviewNeeded: () => [{ attemptId: 4,
    reason: 'completion_interrupted', observedMs: 400 }] };
  assert.deepEqual(listOperationalReview({ acquisitions, publishQueue,
    startQueue, completionQueue }), {
    state: 'review', items: [
      { attemptId: 1, requestId: 7, anidbId: 42,
        stage: 'release_rejected', reason: 'file_wrong_identity', observedMs: 100 },
      { attemptId: 2, requestId: 8, anidbId: 43,
        stage: 'import_hold', reason: 'identity_changed', observedMs: 200 },
      { attemptId: 3, requestId: 9, anidbId: 44,
        stage: 'start_hold', reason: 'provider_unavailable', observedMs: 300 },
      { attemptId: 4, requestId: 10, anidbId: 45,
        stage: 'completion_interrupted', reason: 'completion_interrupted',
        observedMs: 400 },
    ], nextAfterAttemptId: null,
  });
});

test('pages in attempt order and holds on inconsistent evidence', () => {
  const acquisitions = {
    listRejectedNeedsReview: () => [{ attemptId: 1, requestId: 7,
      anidbId: 42, reason: 'file_wrong_identity', observedMs: 100 }],
    getAttempt: () => null,
  };
  const publishQueue = { listReviewNeeded: () => [{ attemptId: 2,
    reason: 'identity_changed', checkedMs: 200 }] };
  const startQueue = { listReviewNeeded: () => [] };
  const completionQueue = { listReviewNeeded: () => [] };
  assert.deepEqual(listOperationalReview({ acquisitions, publishQueue,
    startQueue, completionQueue, limit: 1 }),
    { state: 'review', items: [{ attemptId: 1, requestId: 7,
      anidbId: 42, stage: 'release_rejected',
      reason: 'file_wrong_identity', observedMs: 100 }], nextAfterAttemptId: 1 });
  assert.deepEqual(listOperationalReview({ acquisitions, publishQueue,
    startQueue, completionQueue, limit: 2 }),
    { state: 'held', reason: 'review_evidence_unavailable' });
});
