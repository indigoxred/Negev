import { readBoundedJson } from '../http/bounded-response.mjs';
import { MAX_RELEASE_GUID_LENGTH } from './release-candidate-limits.mjs';

const held = (reason) => ({ state: 'held', reason });
const MAX_TORRENT_BYTES = 2_000_000;

function isTrustedProxy(value, base, apiKey, indexerId) {
  let url;
  try { url = new URL(value); } catch { return false; }
  const params = [...url.searchParams.keys()];
  return url.origin === base.origin && !url.username && !url.password && !url.hash &&
    url.pathname === `${base.pathname === '/' ? '' : base.pathname.slice(0, -1)}/${indexerId}/download` &&
    params.length === 3 && new Set(params).size === 3 &&
    params.every((key) => ['apikey', 'link', 'file'].includes(key)) &&
    url.searchParams.get('apikey') === apiKey &&
    /^[A-Za-z0-9_-]{1,4096}$/.test(url.searchParams.get('link') ?? '') &&
    (url.searchParams.get('file')?.length ?? 0) > 0 &&
    (url.searchParams.get('file')?.length ?? 0) <= 500;
}

// Server-only metadata retrieval. The proxy URL is never returned to a user.
// This does not submit a torrent to qBittorrent or prove AniDB registration.
export async function fetchProwlarrTorrentBytes({
  baseUrl, apiKey, query, candidate, indexerIds,
  fetchImpl = fetch, timeoutMs = 10_000,
}) {
  let base;
  try { base = new URL(baseUrl); } catch { throw new TypeError('Invalid Prowlarr URL'); }
  const term = typeof query === 'string' ? query.trim() : '';
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
      !/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(base.pathname) || base.search || base.hash ||
      typeof apiKey !== 'string' || !apiKey ||
      term.length < 2 || term.length > 120 ||
      typeof candidate?.guid !== 'string' || !candidate.guid || candidate.guid.length > MAX_RELEASE_GUID_LENGTH ||
      !Number.isSafeInteger(candidate.indexerId) || candidate.indexerId < 1 ||
      typeof candidate.title !== 'string' || !candidate.title.trim() || candidate.title.length > 500 ||
      !Number.isSafeInteger(candidate.size) || candidate.size < 1 ||
      !Array.isArray(indexerIds) || indexerIds.length < 1 || indexerIds.length > 20 ||
      new Set(indexerIds).size !== indexerIds.length ||
      !indexerIds.every((id) => Number.isSafeInteger(id) && id > 0) ||
      !indexerIds.includes(candidate.indexerId) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError('Invalid Prowlarr torrent retrieval configuration');
  }
  const headers = { 'X-Api-Key': apiKey };
  const search = new URL(`${base.pathname}api/v1/search`, base);
  search.searchParams.set('query', term);
  search.searchParams.set('type', 'search');
  search.searchParams.set('limit', '50');
  search.searchParams.append('indexerIds', String(candidate.indexerId));

  try {
    const found = await fetchImpl(search, { method: 'GET', headers, redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs) });
    if (found.status !== 200) return held('provider_unavailable');
    const releases = await readBoundedJson(found, 2_000_000);
    if (!Array.isArray(releases) || releases.length > 1_000) return held('provider_unavailable');
    const matches = releases.filter((item) => item?.guid === candidate.guid &&
      item.indexerId === candidate.indexerId && item.protocol === 'torrent' &&
      item.title === candidate.title && item.size === candidate.size);
    if (matches.length !== 1) return held('candidate_changed');
    // Prowlarr may place a torrent descriptor proxy in magnetUrl while
    // leaving downloadUrl null (observed with the installed Nyaa indexer).
    // The same strict proxy-origin and query checks apply to either field.
    const proxyUrl = matches[0].downloadUrl ?? matches[0].magnetUrl;
    if (typeof proxyUrl !== 'string' ||
        !isTrustedProxy(proxyUrl, base, apiKey, candidate.indexerId)) return held('untrusted_proxy');

    const response = await fetchImpl(proxyUrl, { method: 'GET', headers, redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      let location;
      try { location = new URL(response.headers.get('location')); } catch {}
      if (location?.protocol === 'magnet:') return held('magnet_only');
    }
    if (response.status !== 200 ||
        !/^application\/x-bittorrent(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') ||
        !response.body) return held('torrent_unavailable');
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > MAX_TORRENT_BYTES) return held('torrent_too_large');
    const chunks = [];
    let total = 0;
    for await (const chunk of response.body) {
      total += chunk.byteLength;
      if (total > MAX_TORRENT_BYTES) {
        await response.body.cancel().catch(() => {});
        return held('torrent_too_large');
      }
      chunks.push(chunk);
    }
    if (total < 2) return held('invalid_torrent_bytes');
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    if (bytes[0] !== 100 || bytes.at(-1) !== 101) return held('invalid_torrent_bytes');
    return { state: 'torrent_bytes', bytes };
  } catch { return held('provider_unavailable'); }
}
