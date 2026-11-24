const validItem = (item) => Number.isSafeInteger(item?.anidbId) &&
  item.anidbId > 0 && typeof item.title === 'string' &&
  item.title.trim().length > 0;

// Catalogue pages are a browsing aid. A changed result set must be searched
// again rather than silently mixing different snapshots.
export function createSearchPager(first) {
  if (first?.state !== 'results' || first.page !== 1 ||
      !Number.isSafeInteger(first.total) || first.total < 0 ||
      !Array.isArray(first.items) || first.items.length > 20 ||
      first.items.length > first.total ||
      (first.total > 0 && first.items.length === 0) ||
      first.items.some((item) => !validItem(item)) ||
      new Set(first.items.map((item) => item.anidbId)).size !== first.items.length) {
    throw new TypeError('Invalid first catalogue page');
  }
  const items = [...first.items];
  const ids = new Set(items.map((item) => item.anidbId));
  let nextPage = items.length < first.total ? 2 : null;
  return {
    get items() { return [...items]; },
    get nextPage() { return nextPage; },
    append(page) {
      if (nextPage === null || nextPage > 1000 || page?.state !== 'results' ||
          page.page !== nextPage || page.total !== first.total ||
          page.catalogueSource !== first.catalogueSource ||
          !Array.isArray(page.items) || page.items.length < 1 ||
          page.items.length > 20 || items.length + page.items.length > first.total ||
          page.items.some((item) => !validItem(item) || ids.has(item.anidbId)) ||
          new Set(page.items.map((item) => item.anidbId)).size !== page.items.length) {
        return { state: 'held' };
      }
      items.push(...page.items);
      for (const item of page.items) ids.add(item.anidbId);
      nextPage = items.length === first.total ? null : nextPage + 1;
      return { state: 'appended', items: [...page.items] };
    },
  };
}

// Start the adjacent page before fast scrolling reaches it. Grants span markers
// and prevent the larger lead from draining pages while the reader is still.
// A one-shot guard also ignores notifications already queued when disconnected.
export function observeCatalogueContinuation(marker, load, viewportHeight,
  Observer = globalThis.IntersectionObserver,
  { budget = null, readScrollY = () => globalThis.scrollY ?? 0,
    events = globalThis.window } = {}) {
  const lead = Math.min(2400, Math.max(0, Math.round(viewportHeight * 2)));
  let active = true, near = false;
  const intentEvents = ['wheel', 'touchmove', 'keydown', 'pointerdown'];
  const intent = event => {
    if (!active || event?.isTrusted !== true) return;
    if (event.type === 'wheel' && event.deltaY <= 0) return;
    if (event.type === 'keydown' && !['ArrowDown', 'PageDown', 'End', ' '].includes(event.key)) return;
    budget?.noteIntent();
  };
  const disconnect = () => {
    active = false; observer.disconnect(); events?.removeEventListener('scroll', attempt);
    for (const event of intentEvents) events?.removeEventListener(event, intent);
  };
  const attempt = () => {
    if (!active || !near || (budget && !budget.claim(readScrollY(), viewportHeight))) return;
    disconnect(); load();
  };
  const observer = new Observer((entries) => {
    near = entries.some(entry => entry.isIntersecting); attempt();
  }, { rootMargin: '0px 0px '+lead+'px 0px' });
  events?.addEventListener('scroll', attempt, { passive: true });
  for (const event of intentEvents) events?.addEventListener(event, intent, { passive: true });
  observer.observe(marker);
  return { disconnect };
}

export function createCataloguePrefetchBudget() {
  let last = null, intent = 0, used = 0;
  return {
    reset() { last = null; intent = used = 0; },
    noteIntent() { intent++; },
    consume(scrollY) { last = Math.max(0, Number.isFinite(scrollY) ? scrollY : 0); used = intent; },
    claim(scrollY, height) {
      const position = Math.max(0, Number.isFinite(scrollY) ? scrollY : 0);
      const advance = Math.max(120, Math.min(400, height / 2));
      if (last !== null && (intent === used || position < last + advance)) return false;
      last = position; used = intent; return true;
    },
  };
}

// Separate from acquisition. Admit bounded catalogue reads, never retry errors.
export function createCatalogueReadPacer({ now = Date.now, burst = 2,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if(!Number.isSafeInteger(burst)||burst<1||burst>4)throw new TypeError('Invalid bounded read burst');
  let tail = Promise.resolve(), blockedUntil = 0;
  const starts = [];
  return {
    defer(value, fallbackMs = 60_000) {
      const time = now();
      const parsed = /^\d+$/.test(value ?? '') ? time + Number(value) * 1000 : Date.parse(value);
      blockedUntil = Math.max(blockedUntil, Number.isFinite(parsed) && parsed > time ? parsed : time + fallbackMs);
    },
    run(read, current = () => true) {
      const result = tail.then(async () => {
        for (;;) {
          if (!current()) throw new Error('Catalogue read superseded');
          const time = now();
          while (starts.length && starts[0] <= time - 60_000) starts.shift();
          const due = Math.max(blockedUntil, starts.length >= 10 ? starts[0] + 60_000 : 0,
            starts.length >= burst ? starts.at(-1) + 6000 : 0);
          if (due <= time) { starts.push(time); return read(); }
          await sleep(due - time);
        }
      });
      tail = result.catch(() => {}); return result;
    },
  };
}
