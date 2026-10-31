import { readBoundedJson } from '../http/bounded-response.mjs';

const held = (reason) => ({ state: 'held', reason });
const validId = (value) => Number.isSafeInteger(value) && value > 0;
const validCursor = (value) => validId(value?.fileId) &&
  typeof value.importedNs === 'string' && /^[0-9]{1,22}$/.test(value.importedNs) &&
  BigInt(value.importedNs) > 0n;
const compare = (left, right) => {
  const a = BigInt(left.importedNs);
  const b = BigInt(right.importedNs);
  return a < b ? -1 : a > b ? 1 :
    left.fileId < right.fileId ? -1 : left.fileId > right.fileId ? 1 : 0;
};

function importNanoseconds(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const ms = Date.parse(`${match[1]}${match[3]}`);
  if (!Number.isSafeInteger(ms) || ms <= 0) return null;
  return String(BigInt(ms) * 1_000_000n +
    BigInt((match[2] ?? '').padEnd(9, '0') || '0'));
}

// The installed Shoko API accepted this sort and returned timezone-bearing
// Imported values. The list is a recent positive signal, never absence proof.
export async function readShokoRecentPage({ baseUrl, apiKey, page = 1,
  pageSize = 100, fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  let base;
  try { base = new URL(baseUrl); } catch { throw new TypeError('Invalid Shoko URL'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
      base.pathname !== '/' || base.search || base.hash ||
      typeof apiKey !== 'string' || !apiKey || /[\r\n]/.test(apiKey) ||
      !Number.isSafeInteger(page) || page < 1 || page > 10_000 ||
      !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100 ||
      typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError('Invalid recent Shoko page');
  }
  const url = new URL('/api/v3/File', base);
  url.searchParams.set('pageSize', String(pageSize));
  url.searchParams.set('page', String(page));
  url.searchParams.set('include', 'ImportLimbo');
  url.searchParams.set('sortOrder', '-ImportedAt,-FileID');
  try {
    const response = await fetchImpl(url, { method: 'GET', redirect: 'manual',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs) });
    if (response.status !== 200) return { state: 'unavailable' };
    const data = await readBoundedJson(response, 1_000_000);
    if (!Number.isSafeInteger(data?.Total) || data.Total < 0 ||
        !Array.isArray(data.List) || data.List.length !==
          Math.max(0, Math.min(pageSize, data.Total - (page - 1) * pageSize))) {
      return { state: 'unavailable' };
    }
    const seen = new Set();
    const items = [];
    for (const file of data.List) {
      if (!validId(file?.ID) || seen.has(file.ID)) return { state: 'unavailable' };
      const importedNs = importNanoseconds(file.Imported);
      if (!importedNs) return { state: 'unavailable' };
      seen.add(file.ID);
      items.push({ fileId: file.ID, importedNs });
    }
    return { state: 'page', page, total: data.Total, items };
  } catch { return { state: 'unavailable' }; }
}

// At most five pages plus one first-page recheck. Any inconsistent observation
// holds the watermark; returned IDs must be journalled before saving newest.
export async function scanShokoRecentSince({ readPage, since,
  pageSize = 100, maxPages = 5 } = {}) {
  if (typeof readPage !== 'function' || !validCursor(since) ||
      !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100 ||
      !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 5) {
    throw new TypeError('Invalid recent Shoko scan');
  }
  let total;
  let firstHead;
  let previous;
  let newest;
  const seen = new Set();
  const found = [];
  const pageFrom = async (page) => {
    try { return await readPage({ page, pageSize }); }
    catch { return { state: 'unavailable' }; }
  };
  const verifyHead = async () => {
    if (!firstHead) return false;
    const latest = await pageFrom(1);
    return latest?.state === 'page' && latest.page === 1 && latest.total === total &&
      Array.isArray(latest.items) && latest.items.length === firstHead.length &&
      latest.items.every((item, index) => validCursor(item) &&
        compare(item, firstHead[index]) === 0);
  };
  for (let page = 1; page <= maxPages; page++) {
    const result = await pageFrom(page);
    if (result?.state !== 'page' || result.page !== page ||
        !Number.isSafeInteger(result.total) || result.total < 1 ||
        !Array.isArray(result.items) || result.items.length !==
          Math.max(0, Math.min(pageSize, result.total - (page - 1) * pageSize)) ||
        (total !== undefined && result.total !== total)) {
      return held('recent_page_unavailable');
    }
    total = result.total;
    if (page === 1) firstHead = result.items.map((item) => ({ ...item }));
    for (const item of result.items) {
      if (!validCursor(item) || seen.has(item.fileId) ||
          (previous && compare(item, previous) >= 0)) {
        return held('recent_order_unverified');
      }
      seen.add(item.fileId);
      previous = item;
      newest ??= item;
      if (compare(item, since) <= 0) {
        if (!await verifyHead()) return held('recent_head_changed');
        if (compare(newest, since) < 0) return held('recent_head_older');
        return { state: 'complete', fileIds: found.reverse(), newest };
      }
      found.push(item.fileId);
    }
    if (page * pageSize >= total) {
      if (!await verifyHead()) return held('recent_head_changed');
      return { state: 'complete', fileIds: found.reverse(), newest };
    }
  }
  return held('recent_gap_exceeds_budget');
}
