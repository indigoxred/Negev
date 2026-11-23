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

// A first baseline rechecks the newest page. Later gaps use durable bounded
// slices of at most five data pages plus two head checks; journal every slice
// before saving its frontier, and move the cursor only on completion.
export async function scanShokoFileIdsSince({ readPage, sinceId,
  pageSize = 100, maxPages = 5, continuation = null } = {}) {
  if (typeof readPage !== 'function' ||
      (sinceId !== null && !validId(sinceId)) ||
      !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100 ||
      !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 5) {
    throw new TypeError('Invalid Shoko file-ID scan');
  }
  let total = continuation?.total;
  let head = continuation?.head;
  let newestId = continuation?.newestId;
  let previous = continuation?.previous;
  const startPage = continuation?.page ?? 1;
  const found = [];
  let headUnavailable = false;
  const read = async (page) => {
    try { return await readPage({ page, pageSize }); }
    catch { return { state: 'unavailable' }; }
  };
  const stableHead = async () => {
    const next = await read(1);
    headUnavailable = next?.state !== 'page';
    if (headUnavailable) return false;
    return next?.state === 'page' && next.page === 1 &&
      next.total === total && Array.isArray(next.fileIds) &&
      next.fileIds.length === head.length &&
      next.fileIds.every((id, index) => id === head[index]);
  };
  if (continuation && (continuation.sinceId !== sinceId ||
      !Number.isSafeInteger(startPage) || startPage < 2 || !validId(previous) ||
      !validId(newestId) || !Array.isArray(head) || !await stableHead())) {
    return { ...held('file_id_head_changed'), restart: !headUnavailable };
  }
  const complete = (fileIds) => ({ state: 'complete', fileIds, newestId,
    ...(continuation ? { sinceId, resumed: true } : {}) });
  for (let page = startPage; page < startPage + maxPages; page++) {
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
        return complete(found.reverse());
      }
      found.push(id);
    }
    if (sinceId === null || page * pageSize >= total) {
      if (!await stableHead()) return held('file_id_head_changed');
      return complete(found.reverse());
    }
  }
  if (!await stableHead()) return { ...held('file_id_head_changed'), restart: !headUnavailable };
  return { state: 'continuing', fileIds: found.reverse(), newestId, sinceId,
    continuation: { total, head, previous, newestId, sinceId,
      page: startPage + maxPages } };
}
