import { readBoundedJson } from '../http/bounded-response.mjs';
import { MAX_RELEASE_GUID_LENGTH } from './release-candidate-limits.mjs';
import { isTrustedProxy } from './prowlarr-torrent-bytes.mjs';
import { compareReleases, hasTargetEpisodeHint } from './release-preference.mjs';

// Prowlarr GET /api/v1/search only. A release is a search candidate, not
// evidence that its video is registered in AniDB or safe to import.
export async function searchReleaseCandidates({
  baseUrl, apiKey, query, indexerIds, trustedIndexerIds = [],
  categories = [], limit = 25,
  targetEpisodeNumber = null,
  includeProxyUrl = false,
  fetchImpl = fetch, timeoutMs = 10_000,
}) {
  const term = typeof query === 'string' ? query.trim() : '';
  const validIds = (ids, max) => Array.isArray(ids) && ids.length <= max &&
    ids.every((id) => Number.isSafeInteger(id) && id > 0) && new Set(ids).size === ids.length;
  if (term.length < 2 || term.length > 120 || !validIds(indexerIds, 20) ||
      indexerIds.length === 0 || !validIds(trustedIndexerIds, 20) ||
      trustedIndexerIds.some((id) => !indexerIds.includes(id)) ||
      !validIds(categories, 20) ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 50 ||
      (targetEpisodeNumber !== null && (!Number.isSafeInteger(targetEpisodeNumber) ||
        targetEpisodeNumber < 1 || targetEpisodeNumber > 9999))) {
    return { state: 'invalid_query' };
  }
  let base;
  try { base = new URL(baseUrl); } catch { throw new TypeError('Invalid Prowlarr URL'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
      base.search || base.hash || typeof apiKey !== 'string' || !apiKey ||
      typeof includeProxyUrl !== 'boolean' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError('Invalid Prowlarr search configuration');
  }

  if (!/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(base.pathname)) {
    throw new TypeError('Invalid Prowlarr URL base');
  }
  const url = new URL(`${base.pathname}api/v1/search`, base);
  url.searchParams.set('query', term);
  url.searchParams.set('type', 'search');
  url.searchParams.set('limit', String(limit));
  for (const id of indexerIds) url.searchParams.append('indexerIds', String(id));
  for (const id of categories) url.searchParams.append('categories', String(id));

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status !== 200) return { state: 'unavailable' };
    const data = await readBoundedJson(response, 2_000_000);
    if (!Array.isArray(data) || data.length > 1_000 || data.some((item) =>
      typeof item?.guid !== 'string' || !item.guid || item.guid.length > MAX_RELEASE_GUID_LENGTH ||
      !indexerIds.includes(item.indexerId) || typeof item.title !== 'string' ||
      !item.title.trim() || item.title.length > 500 ||
      !Number.isSafeInteger(item.size) || item.size <= 0 ||
      !['torrent', 'usenet'].includes(item.protocol) ||
      (item.seeders != null && (!Number.isSafeInteger(item.seeders) || item.seeders < 0)))) {
      return { state: 'unavailable' };
    }
    // Prowlarr's limit is applied per indexer. Its aggregate can contain a
    // full page from one indexer before any row from the next one.
    const byIndexer = new Map(indexerIds.map((id) => [id, []]));
    for (const item of data) {
      if (item.protocol === 'torrent') byIndexer.get(item.indexerId).push(item);
    }
    // Prowlarr can return a valid exact episode below its first page of
    // unrelated hits. Promote exact coordinates before the local page cap;
    // the later metainfo, Shoko identity and track checks still decide safety.
    if (targetEpisodeNumber !== null) {
      for (const bucket of byIndexer.values()) {
        bucket.sort((left, right) => {
          const a = hasTargetEpisodeHint(left, targetEpisodeNumber);
          const b = hasTargetEpisodeHint(right, targetEpisodeNumber);
          if (a !== b) return Number(b) - Number(a);
          return a ? compareReleases(left, right) : 0;
        });
      }
    }
    const selected = [];
    for (let offset = 0; selected.length < limit; offset++) {
      let added = false;
      for (const id of indexerIds) {
        const item = byIndexer.get(id)[offset];
        if (!item) continue;
        selected.push(item);
        added = true;
        if (selected.length === limit) break;
      }
      if (!added) break;
    }
    return {
      state: 'candidates',
      items: selected.map((item) => ({
        guid: item.guid, indexerId: item.indexerId, title: item.title,
        size: item.size, protocol: item.protocol,
        seeders: item.seeders ?? null, evidence: 'unverified',
        ...(trustedIndexerIds.includes(item.indexerId) ? { trusted: true } : {}),
        ...(includeProxyUrl && isTrustedProxy(item.downloadUrl ?? item.magnetUrl,
          base, apiKey, item.indexerId) ?
          { proxyUrl: item.downloadUrl ?? item.magnetUrl } : {}),
      })),
      ...(data.length === 0 ? { exhaustive: false } : {}),
    };
  } catch {
    return { state: 'unavailable' };
  }
}
