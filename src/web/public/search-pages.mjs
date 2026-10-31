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
