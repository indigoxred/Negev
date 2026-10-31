// One durable page per explicit tick. The caller supplies the existing paced
// catalogue poll; this worker neither schedules itself nor dispatches media.
export function createAiringPageWorker({ ledger, pollPage, limit = 3 } = {}) {
  if (typeof ledger?.getAiringCursor !== 'function' ||
      typeof ledger?.advanceAiringCursor !== 'function' ||
      typeof pollPage !== 'function' ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 10) {
    throw new TypeError('Invalid Airing page worker');
  }
  let busy = false;
  return {
    async runOnce() {
      if (busy) return { state: 'held', reason: 'poll_in_progress' };
      busy = true;
      try {
        const afterId = ledger.getAiringCursor();
        const page = await pollPage({ afterId, limit });
        if (page?.state !== 'page') return page;
        const nextAfterId = page.nextAfterId ?? 0;
        if (!Number.isSafeInteger(nextAfterId) || nextAfterId < 0 ||
            (nextAfterId !== 0 && nextAfterId <= afterId)) {
          return { state: 'held', reason: 'invalid_poll_page' };
        }
        const advance = ledger.advanceAiringCursor({ expectedAfterId: afterId, nextAfterId });
        return advance.state === 'advanced'
          ? { state: 'page', results: page.results, afterId: nextAfterId }
          : advance;
      } finally { busy = false; }
    },
  };
}
