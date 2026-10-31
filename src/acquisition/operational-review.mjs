const validId = (value) => Number.isSafeInteger(value) && value > 0;
const validReason = (value) => typeof value === 'string' &&
  /^[a-z][a-z0-9_]{0,79}$/.test(value);
const held = () => ({ state: 'held', reason: 'review_evidence_unavailable' });

// Admin read only. The returned rows deliberately omit hashes, paths and
// indexer details; neither a review row nor its absence changes a job state.
export function listOperationalReview({ acquisitions, publishQueue,
  afterAttemptId = 0, limit = 20 } = {}) {
  if (typeof acquisitions?.listRejectedNeedsReview !== 'function' ||
      typeof acquisitions.getAttempt !== 'function' ||
      typeof publishQueue?.listReviewNeeded !== 'function' ||
      !Number.isSafeInteger(afterAttemptId) || afterAttemptId < 0 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
    throw new TypeError('Invalid operational review');
  }
  let rejected, publish;
  try {
    rejected = acquisitions.listRejectedNeedsReview({ afterAttemptId,
      limit: limit + 1 });
    publish = publishQueue.listReviewNeeded({ afterAttemptId,
      limit: limit + 1 });
  } catch { return held(); }
  const ordered = (rows) => Array.isArray(rows) && rows.length <= limit + 1 &&
    rows.every((row, index) => validId(row?.attemptId) &&
      row.attemptId > (index === 0 ? afterAttemptId : rows[index - 1].attemptId));
  if (!ordered(rejected) || !ordered(publish)) return held();
  const candidates = [
    ...rejected.map((row) => ({ ...row, stage: 'release_rejected' })),
    ...publish.map((row) => ({ ...row, stage: 'import_hold' })),
  ].sort((a, b) => a.attemptId - b.attemptId);
  if (new Set(candidates.map((row) => row.attemptId)).size !== candidates.length) {
    return held();
  }
  const items = [];
  for (const row of candidates.slice(0, limit)) {
    let requestId = row.requestId;
    let anidbId = row.anidbId;
    const observedMs = row.stage === 'release_rejected'
      ? row.observedMs : row.checkedMs;
    if (row.stage === 'import_hold') {
      let attempt;
      try { attempt = acquisitions.getAttempt(row.attemptId); }
      catch { return held(); }
      if (attempt?.id !== row.attemptId) return held();
      requestId = attempt.requestId;
      anidbId = attempt.anidbId;
    }
    if (!validId(requestId) || !validId(anidbId) ||
        !validReason(row.reason) || !Number.isSafeInteger(observedMs) ||
        observedMs < 0) return held();
    items.push({ attemptId: row.attemptId, requestId, anidbId,
      stage: row.stage, reason: row.reason, observedMs });
  }
  return { state: 'review', items,
    nextAfterAttemptId: candidates.length > limit ? items.at(-1).attemptId : null };
}
