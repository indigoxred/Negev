// Prowlarr GET /api/v1/search only. A release is a search candidate, not
// evidence that its video is registered in AniDB or safe to import.
export async function searchReleaseCandidates({
  baseUrl, apiKey, query, indexerIds, categories = [], limit = 25,
  fetchImpl = fetch, timeoutMs = 10_000,
}) {
  const term = typeof query === 'string' ? query.trim() : '';
  const validIds = (ids, max) => Array.isArray(ids) && ids.length <= max &&
    ids.every((id) => Number.isSafeInteger(id) && id > 0) && new Set(ids).size === ids.length;
  if (term.length < 2 || term.length > 120 || !validIds(indexerIds, 20) ||
      indexerIds.length === 0 || !validIds(categories, 20) ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    return { state: 'invalid_query' };
  }
  let base;
  try { base = new URL(baseUrl); } catch { throw new TypeError('Invalid Prowlarr URL'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
      base.search || base.hash || typeof apiKey !== 'string' || !apiKey ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError('Invalid Prowlarr search configuration');
  }

  const url = new URL('/api/v1/search', base);
  url.searchParams.set('query', term);
  url.searchParams.set('type', 'search');
  url.searchParams.set('limit', String(limit));
  for (const id of indexerIds) url.searchParams.append('indexerIds', String(id));
  for (const id of categories) url.searchParams.append('categories', String(id));

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status !== 200) return { state: 'unavailable' };
    const body = await response.text();
    if (body.length > 2_000_000) return { state: 'unavailable' };
    const data = JSON.parse(body);
    if (!Array.isArray(data) || data.length > limit || data.some((item) =>
      typeof item?.guid !== 'string' || !item.guid || item.guid.length > 500 ||
      !indexerIds.includes(item.indexerId) || typeof item.title !== 'string' ||
      !item.title.trim() || item.title.length > 500 ||
      !Number.isSafeInteger(item.size) || item.size <= 0 ||
      !['torrent', 'usenet'].includes(item.protocol) ||
      (item.seeders != null && (!Number.isSafeInteger(item.seeders) || item.seeders < 0)))) {
      return { state: 'unavailable' };
    }
    return {
      state: 'candidates',
      items: data.filter((item) => item.protocol === 'torrent').map((item) => ({
        guid: item.guid, indexerId: item.indexerId, title: item.title,
        size: item.size, protocol: item.protocol,
        seeders: item.seeders ?? null, evidence: 'unverified',
      })),
      ...(data.length === 0 ? { exhaustive: false } : {}),
    };
  } catch {
    return { state: 'unavailable' };
  }
}
