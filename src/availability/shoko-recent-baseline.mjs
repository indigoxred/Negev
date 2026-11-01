const held = (reason) => ({ state: 'held', reason });
// File ID stays positive so existing SQLite cursor tables need no migration.
// Imported=0 is older than every real Shoko import timestamp.
const emptyCursor = { fileId: 1, importedNs: '0' };
const validCursor = (value) => Number.isSafeInteger(value?.fileId) &&
  value.fileId > 0 && typeof value.importedNs === 'string' &&
  /^[0-9]{1,22}$/.test(value.importedNs) &&
  (BigInt(value.importedNs) > 0n ||
    (value.fileId === emptyCursor.fileId && value.importedNs === '0'));
const compare = (left, right) => {
  const a = BigInt(left.importedNs);
  const b = BigInt(right.importedNs);
  return a < b ? -1 : a > b ? 1 :
    left.fileId < right.fileId ? -1 : left.fileId > right.fileId ? 1 : 0;
};
const validHead = (page) => {
  if (page?.state !== 'page' || page.page !== 1 ||
      !Number.isSafeInteger(page.total) || page.total < 0 ||
      !Array.isArray(page.items) ||
      page.items.length !== Math.min(100, page.total)) return false;
  const ids = new Set();
  let previous;
  for (const item of page.items) {
    if (!validCursor(item) || ids.has(item.fileId) ||
        previous && compare(item, previous) >= 0) return false;
    ids.add(item.fileId);
    previous = item;
  }
  return true;
};

// Explicit setup only, never automatic startup. Queue the stable head with
// its watermark so files imported just before setup are not skipped. Older
// historical files still require a separate backfill.
export async function bootstrapShokoRecentHead({ ledger, readPage } = {}) {
  if (typeof ledger?.getCursor !== 'function' ||
      typeof ledger?.getCapacity !== 'function' ||
      typeof ledger?.bootstrap !== 'function' ||
      typeof readPage !== 'function') {
    throw new TypeError('Invalid recent Shoko baseline');
  }
  if (ledger.getCursor() || ledger.getCapacity().pending !== 0) {
    return held('recent_baseline_exists');
  }
  let first, second;
  try {
    first = await readPage({ page: 1, pageSize: 100 });
    if (!validHead(first)) return held('recent_head_unverified');
    second = await readPage({ page: 1, pageSize: 100 });
  } catch { return held('recent_head_unavailable'); }
  if (!validHead(second)) return held('recent_head_unverified');
  if (first.total !== second.total || first.items.length !== second.items.length ||
      first.items.some((item, index) =>
        compare(item, second.items[index]) !== 0)) {
    return held('recent_head_changed');
  }
  const cursor = first.items.length ? { ...first.items[0] } : { ...emptyCursor };
  const saved = ledger.bootstrap(cursor,
    first.items.map((item) => item.fileId).reverse());
  return saved.state === 'baseline_saved' ? { ...saved, cursor } : saved;
}
