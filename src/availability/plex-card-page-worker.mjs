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
  for (const ratingKey of page.keys) {
    let card;
    try { card = await readCard({ libraryId, ratingKey,
      expectedType: kind }); }
    catch { return held('card_unavailable'); }
    if (card?.state !== 'ok' || card.complete !== true ||
        !Array.isArray(card.parts) || card.parts.length < 1) {
      return held('card_unavailable');
    }
    try {
      const saved = index.recordCard({ libraryId, ratingKey, kind,
        parts: card.parts, observedMs });
      if (!['recorded_card', 'stale_card'].includes(saved?.state)) {
        return held('card_record_unavailable');
      }
    } catch { return held('card_record_unavailable'); }
  }
  const nextOffset = page.keys.length < pageSize ||
    (page.totalSize !== null && offset + page.keys.length >= page.totalSize)
    ? 0 : offset + page.keys.length;
  return { state: 'page_indexed', processed: page.keys.length, nextOffset };
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
