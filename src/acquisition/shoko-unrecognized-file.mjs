import { readBoundedJson } from '../http/bounded-response.mjs';

// Shoko's explicit Unrecognized classification is checked only after the
// exact path has remained unmatched across two quiet import observations.
export async function readShokoUnrecognizedFile({ baseUrl, apiKey, fileId,
  fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  let base;
  try { base = new URL(baseUrl); }
  catch { throw new TypeError('Invalid Shoko unrecognized lookup'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username ||
      base.password || base.pathname !== '/' || base.search || base.hash ||
      typeof apiKey !== 'string' || !apiKey ||
      !Number.isSafeInteger(fileId) || fileId < 1 ||
      typeof fetchImpl !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
      timeoutMs > 60_000) throw new TypeError('Invalid Shoko unrecognized lookup');
  try {
    const url = new URL('/api/v3/File', base);
    url.searchParams.set('include_only', 'Unrecognized');
    url.searchParams.set('pageSize', '100');
    url.searchParams.set('page', '1');
    const response = await fetchImpl(url, { method: 'GET',
      redirect: 'manual', headers: {
        Authorization: `Bearer ${apiKey}`, Accept: 'application/json',
      }, signal: AbortSignal.timeout(timeoutMs) });
    if (response.status !== 200) return { state: 'unavailable' };
    const page = await readBoundedJson(response, 2_000_000);
    if (!Number.isSafeInteger(page?.Total) || page.Total < 0 ||
        page.Total > 100 || !Array.isArray(page.List) ||
        page.List.length !== page.Total ||
        page.List.some((item) => !Number.isSafeInteger(item?.ID) ||
          item.ID < 1)) return { state: 'unavailable' };
    return { state: page.List.some((item) => item.ID === fileId)
      ? 'unrecognized' : 'not_unrecognized' };
  } catch { return { state: 'unavailable' }; }
}
