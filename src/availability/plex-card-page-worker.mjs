const validId = (value) => Number.isSafeInteger(value) && value > 0;
const held = (reason) => ({ state: 'held', reason });

// Explicit single tick: one scoped Plex key page and at most five card reads.
// The caller owns a durable offset and pacing. A failed card keeps the page
// retryable; even a completed sweep is positive discovery, never absence proof.
export async function indexPlexCardPage({ libraryId, kind, offset,
  pageSize = 5, readPage, readCard, index, now = Date.now } = {}) {
  if (!validId(libraryId) || !['episode', 'movie'].includes(kind) ||
      !Number.isSafeInteger(offset) || offset < 0 ||
      !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 5 ||
      typeof readPage !== 'function' || typeof readCard !== 'function' ||
      typeof index?.recordCard !== 'function' || typeof now !== 'function') {
    throw new TypeError('Invalid Plex index page configuration');
  }
  const observedMs = now();
  if (!Number.isSafeInteger(observedMs) || observedMs < 0) return held('invalid_clock');
  let page;
  try { page = await readPage({ libraryId, kind, offset, pageSize }); }
  catch { return held('key_page_unavailable'); }
  if (page?.state !== 'page' || page.libraryId !== libraryId ||
      page.kind !== kind || page.offset !== offset ||
      !Array.isArray(page.keys) || page.keys.length > pageSize ||
      page.keys.some((key) => !validId(key)) ||
      new Set(page.keys).size !== page.keys.length ||
      (page.totalSize !== null &&
        (!Number.isSafeInteger(page.totalSize) ||
          page.totalSize < offset + page.keys.length))) {
    return held('key_page_unavailable');
  }
  let processed = 0;
  let skipped = 0;
  const defer = (ratingKey) => {
    try { index.deferCard?.({ libraryId, ratingKey, kind, nowMs: observedMs }); }
    catch { /* The page remains positive-only and the next sweep can retry. */ }
  };
  for (const ratingKey of page.keys) {
    let card;
    try { card = await readCard({ libraryId, ratingKey,
      expectedType: kind }); }
    catch { skipped++; defer(ratingKey); continue; }
    if (card?.state !== 'ok' || card.complete !== true ||
        !Array.isArray(card.parts) || card.parts.length < 1) {
      skipped++;
      if (card?.state === 'not_found') {
        try { index.forgetCard?.({ libraryId, ratingKey, observedMs }); }
        catch { defer(ratingKey); }
      } else defer(ratingKey);
      continue;
    }
    try {
      const saved = index.recordCard({ libraryId, ratingKey, kind,
        parts: card.parts, observedMs });
      if (!['recorded_card', 'stale_card'].includes(saved?.state)) {
        skipped++; continue;
      }
      processed++;
    } catch { skipped++; defer(ratingKey); }
  }
  const nextOffset = page.keys.length < pageSize ||
    (page.totalSize !== null && offset + page.keys.length >= page.totalSize)
    ? 0 : offset + page.keys.length;
  return { state: 'page_indexed', processed,
    ...(skipped ? { skipped } : {}), nextOffset };
}

export function createPlexCardPageWorker({ libraryId, kind, pageSize = 5,
  index, readPage, readCard, now = Date.now } = {}) {
  if (!validId(libraryId) || !['episode', 'movie'].includes(kind) ||
      typeof index?.getCursor !== 'function' ||
      typeof index?.advanceCursor !== 'function') {
    throw new TypeError('Invalid Plex card page worker');
  }
  return {
    async tick() {
      const offset = index.getCursor({ libraryId, kind });
      const result = await indexPlexCardPage({ libraryId, kind, offset,
        pageSize, index, readPage, readCard, now });
      if (result.state !== 'page_indexed') return result;
      const advanced = index.advanceCursor({ libraryId, kind,
        expectedOffset: offset, nextOffset: result.nextOffset });
      return advanced.state === 'cursor_advanced' ? result : advanced;
    },
  };
}

// One due retry per paced tick. A transient card error cannot hide an older
// arrival until a full library sweep, and a persistent error cannot stall it.
export async function retryOnePlexCard({ libraryId, kind, index, readCard,
  now = Date.now } = {}) {
  if (!validId(libraryId) || !['episode', 'movie'].includes(kind) ||
      typeof index?.nextRetry !== 'function' ||
      typeof index?.recordCard !== 'function' ||
      typeof index?.deferCard !== 'function' ||
      typeof index?.clearRetry !== 'function' ||
      typeof readCard !== 'function' || typeof now !== 'function') {
    throw new TypeError('Invalid Plex card retry worker');
  }
  const nowMs = now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) return held('invalid_clock');
  const due = index.nextRetry({ libraryId, kind, nowMs });
  if (!due) return { state: 'no_due_retry' };
  if (!validId(due.ratingKey)) return held('invalid_retry');
  let card;
  try { card = await readCard({ libraryId, ratingKey: due.ratingKey,
    expectedType: kind }); }
  catch { card = { state: 'unavailable' }; }
  if (card?.state === 'not_found') {
    try {
      if (typeof index.forgetCard === 'function') index.forgetCard({
        libraryId, ratingKey: due.ratingKey, observedMs: nowMs });
      else index.clearRetry({ libraryId, ratingKey: due.ratingKey });
    } catch {
      index.deferCard({ libraryId, ratingKey: due.ratingKey, kind, nowMs });
      return { state: 'retry_deferred', ratingKey: due.ratingKey };
    }
    return { state: 'retry_missing', ratingKey: due.ratingKey };
  }
  if (card?.state === 'ok' && card.complete === true &&
      Array.isArray(card.parts) && card.parts.length > 0) {
    try {
      const result = index.recordCard({ libraryId, ratingKey: due.ratingKey,
        kind, parts: card.parts, observedMs: nowMs });
      if (result?.state === 'recorded_card') {
        return { state: 'retry_indexed', ratingKey: due.ratingKey };
      }
      if (result?.state === 'stale_card') {
        index.clearRetry({ libraryId, ratingKey: due.ratingKey });
        return { state: 'retry_superseded', ratingKey: due.ratingKey };
      }
    } catch { /* Retry later with bounded backoff. */ }
  }
  index.deferCard({ libraryId, ratingKey: due.ratingKey, kind, nowMs });
  return { state: 'retry_deferred', ratingKey: due.ratingKey };
}
