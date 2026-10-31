import { readBoundedJson } from '../http/bounded-response.mjs';

const unavailable = () => ({ state: 'unavailable' });
const integer = (value, minimum = 0) => {
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) value = Number(value);
  return Number.isSafeInteger(value) && value >= minimum ? value : null;
};

// One page of known rating keys from an explicitly selected Plex section.
// Offset paging can shift while Plex changes; a page never proves the rest of
// the library absent. Durable discovery/reconciliation belongs to the caller.
export async function readPlexSectionKeys({ baseUrl, token, libraryId, kind,
  offset = 0, pageSize = 24, fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  let base;
  try { base = new URL(baseUrl); } catch { throw new TypeError('Invalid Plex URL'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
      base.search || base.hash || base.pathname !== '/' ||
      typeof token !== 'string' || !token || /[\r\n]/.test(token) ||
      integer(libraryId, 1) === null || !['episode', 'movie'].includes(kind) ||
      integer(offset) === null || integer(pageSize, 1) === null || pageSize > 50 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 ||
      typeof fetchImpl !== 'function') throw new TypeError('Invalid Plex section observation');
  let body;
  try {
    const url = new URL(`/library/sections/${libraryId}/all`, base);
    url.searchParams.set('type', kind === 'episode' ? '4' : '1');
    url.searchParams.set('sort', 'addedAt:desc');
    const response = await fetchImpl(url, { method: 'GET', redirect: 'manual',
      headers: { 'X-Plex-Token': token, Accept: 'application/json',
        'X-Plex-Client-Identifier': 'negev-availability-observer',
        'X-Plex-Container-Start': String(offset),
        'X-Plex-Container-Size': String(pageSize) },
      signal: AbortSignal.timeout(timeoutMs) });
    if (response.status !== 200) return unavailable();
    body = await readBoundedJson(response, 1_000_000);
  } catch { return unavailable(); }
  const container = body?.MediaContainer;
  const hasTotal = container != null && Object.hasOwn(container, 'totalSize');
  const totalSize = hasTotal ? integer(container.totalSize) : null;
  const size = integer(container?.size);
  if (integer(container?.librarySectionID) !== integer(libraryId) ||
      integer(container?.offset) !== integer(offset) ||
      size === null || size > pageSize ||
      (hasTotal && (totalSize === null || totalSize < offset + size)) ||
      !Array.isArray(container.Metadata) ||
      container.Metadata.length !== size) return unavailable();
  const keys = [];
  const seen = new Set();
  for (const item of container.Metadata) {
    const key = integer(item?.ratingKey, 1);
    const itemLibrary = item?.librarySectionID === undefined ? integer(libraryId) :
      integer(item.librarySectionID, 1);
    if (key === null || seen.has(key) || item?.type !== kind ||
        itemLibrary !== integer(libraryId)) return unavailable();
    seen.add(key);
    keys.push(key);
  }
  return { state: 'page', libraryId: integer(libraryId), kind,
    offset: integer(offset), totalSize, keys, complete: false };
}
