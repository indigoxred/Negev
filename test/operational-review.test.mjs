import assert from 'node:assert/strict';
import test from 'node:test';
import { listOperationalReview } from '../src/acquisition/operational-review.mjs';

test('combines terminal import holds and wrong-file rejections without exposing hashes', () => {
  const acquisitions = {
    listRejectedNeedsReview: () => [{ attemptId: 1, requestId: 7,
      anidbId: 42, reason: 'file_wrong_identity', observedMs: 100 }],
    getAttempt: (id) => id === 2 ? { id, requestId: 8, anidbId: 43,
      torrentHash: 'secret' } : null,
  };
  const publishQueue = { listReviewNeeded: () => [{ attemptId: 2,
    reason: 'identity_changed', checkedMs: 200 }] };
  assert.deepEqual(listOperationalReview({ acquisitions, publishQueue }), {
    state: 'review', items: [
      { attemptId: 1, requestId: 7, anidbId: 42,
        stage: 'release_rejected', reason: 'file_wrong_identity', observedMs: 100 },
      { attemptId: 2, requestId: 8, anidbId: 43,
        stage: 'import_hold', reason: 'identity_changed', observedMs: 200 },
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
  assert.deepEqual(listOperationalReview({ acquisitions, publishQueue, limit: 1 }),
    { state: 'review', items: [{ attemptId: 1, requestId: 7,
      anidbId: 42, stage: 'release_rejected',
      reason: 'file_wrong_identity', observedMs: 100 }], nextAfterAttemptId: 1 });
  assert.deepEqual(listOperationalReview({ acquisitions, publishQueue, limit: 2 }),
    { state: 'held', reason: 'review_evidence_unavailable' });
});
