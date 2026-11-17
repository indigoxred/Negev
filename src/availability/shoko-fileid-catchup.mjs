import { readBoundedJson } from '../http/bounded-response.mjs';

const validId = (value) => Number.isSafeInteger(value) && value > 0;
const held = (reason) => ({ state: 'held', reason });

// Shoko can leave Imported null for recognized files. FileID ordering is a
// positive catch-up signal; it never proves that a file is available in Plex.
export async function readShokoFileIdPage({ baseUrl, apiKey, page = 1,
  pageSize = 100, fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  let base;
  try { base = new URL(baseUrl); } catch { throw new TypeError('Invalid Shoko URL'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
      base.pathname !== '/' || base.search || base.hash ||
      typeof apiKey !== 'string' || !apiKey || /[\r\n]/.test(apiKey) ||
      !Number.isSafeInteger(page) || page < 1 || page > 10_000 ||
      !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 ||
      typeof fetchImpl !== 'function') throw new TypeError('Invalid Shoko file-ID page');
  const url = new URL('/api/v3/File', base);
  url.searchParams.set('pageSize', String(pageSize));
  url.searchParams.set('page', String(page));
  url.searchParams.set('sortOrder', '-FileID');
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
    const fileIds = data.List.map((file) => file?.ID);
    if (fileIds.some((id, index) => !validId(id) ||
        (index > 0 && id >= fileIds[index - 1]))) return { state: 'unavailable' };
    return { state: 'page', page, total: data.Total, fileIds };
  } catch { return { state: 'unavailable' }; }
}

// One stable snapshot, at most five 100-file pages. A first scan rechecks
// only the newest page; subsequent scans require the saved cursor within the
// page budget. Pending IDs must be journalled before moving that cursor.
export async function scanShokoFileIdsSince({ readPage, sinceId,
  pageSize = 100, maxPages = 5 } = {}) {
  if (typeof readPage !== 'function' ||
      (sinceId !== null && !validId(sinceId)) ||
      !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100 ||
      !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 5) {
    throw new TypeError('Invalid Shoko file-ID scan');
  }
  let total;
  let head;
  let newestId;
  let previous;
  const found = [];
  const read = async (page) => {
    try { return await readPage({ page, pageSize }); }
    catch { return { state: 'unavailable' }; }
  };
  const stableHead = async () => {
    const next = await read(1);
    return next?.state === 'page' && next.page === 1 &&
      next.total === total && Array.isArray(next.fileIds) &&
      next.fileIds.length === head.length &&
      next.fileIds.every((id, index) => id === head[index]);
  };
  for (let page = 1; page <= maxPages; page++) {
    const result = await read(page);
    if (result?.state !== 'page' || result.page !== page ||
        !Number.isSafeInteger(result.total) || result.total < 0 ||
        !Array.isArray(result.fileIds) || result.fileIds.length !==
          Math.max(0, Math.min(pageSize, result.total - (page - 1) * pageSize)) ||
        (total !== undefined && result.total !== total)) {
      return held('file_id_page_unavailable');
    }
    total = result.total;
    if (page === 1) {
      head = [...result.fileIds];
      newestId = head[0];
      if (!validId(newestId)) return held('file_id_empty');
      if (sinceId !== null && newestId < sinceId) return held('file_id_head_older');
    }
    for (const id of result.fileIds) {
      if (!validId(id) || (previous !== undefined && id >= previous)) {
        return held('file_id_order_unverified');
      }
      previous = id;
      if (sinceId !== null && id <= sinceId) {
        if (!await stableHead()) return held('file_id_head_changed');
        return { state: 'complete', fileIds: found.reverse(), newestId };
      }
      found.push(id);
    }
    if (sinceId === null || page * pageSize >= total) {
      if (!await stableHead()) return held('file_id_head_changed');
      return { state: 'complete', fileIds: found.reverse(), newestId };
    }
  }
  return held('file_id_gap_exceeds_budget');
}
