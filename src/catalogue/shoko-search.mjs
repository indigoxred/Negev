import { readBoundedJson } from '../http/bounded-response.mjs';

// Shoko's title cache reaches beyond locally imported series, but a search
// hit alone does not contain the episode detail needed for a request.
export async function searchAniDbTitles({
  baseUrl, apiKey, query, page = 1, pageSize = 20,
  fetchImpl = fetch, timeoutMs = 10_000,
}) {
  const term = typeof query === 'string' ? query.trim() : '';
  if (term.length < 2 || term.length > 120 ||
      !Number.isSafeInteger(page) || page < 1 || page > 1000 ||
      !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) {
    return { state: 'invalid_query' };
  }
  let base;
  try { base = new URL(baseUrl); } catch { throw new TypeError('Invalid Shoko base URL'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
      base.search || base.hash || typeof apiKey !== 'string' || !apiKey ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError('Invalid Shoko search configuration');
  }

  const url = new URL('/api/v3/Series/AniDB/Search', base);
  url.searchParams.set('query', term);
  url.searchParams.set('page', String(page));
  url.searchParams.set('pageSize', String(pageSize));
  url.searchParams.set('includeTitles', 'false');

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status !== 200) return { state: 'unavailable' };
    const data = await readBoundedJson(response, 1_000_000);
    if (!Number.isSafeInteger(data?.Total) || data.Total < 0 ||
        !Array.isArray(data.List) || data.List.length > pageSize ||
        data.List.some((item) => !Number.isSafeInteger(item?.ID) || item.ID <= 0 ||
          typeof item.Title !== 'string' || !item.Title.trim())) {
      return { state: 'unavailable' };
    }
    return {
      state: 'results', total: data.Total, page,
      items: data.List.map((item) => ({
        anidbId: item.ID,
        title: item.Title,
        detailState: 'pending',
        requestable: false,
      })),
    };
  } catch {
    return { state: 'unavailable' };
  }
}
