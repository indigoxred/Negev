import { readBoundedJson } from '../http/bounded-response.mjs';
import { parsePlexCardParts } from './plex-item-parts.mjs';

const unavailable = () => ({ state: 'unavailable' });
const integer = (value, minimum = 0) => {
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) value = Number(value);
  return Number.isSafeInteger(value) && value >= minimum ? value : null;
};

// One page of known rating keys from an explicitly selected Plex section.
// Offset paging can shift while Plex changes; a page never proves the rest of
// the library absent. Durable discovery/reconciliation belongs to the caller.
export async function readPlexSectionKeys({ baseUrl, token, libraryId, kind,
  offset = 0, pageSize = 24, includeCards = false,
  fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  let base;
  try { base = new URL(baseUrl); } catch { throw new TypeError('Invalid Plex URL'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
      base.search || base.hash || base.pathname !== '/' ||
      typeof token !== 'string' || !token || /[\r\n]/.test(token) ||
      integer(libraryId, 1) === null || !['episode', 'movie'].includes(kind) ||
      integer(offset) === null || integer(pageSize, 1) === null || pageSize > 50 ||
      typeof includeCards !== 'boolean' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 ||
      typeof fetchImpl !== 'function') throw new TypeError('Invalid Plex section observation');
  let body;
  let responseStart = null;
  let responseTotal = null;
  let hasResponseStart = false;
  let hasResponseTotal = false;
  try {
    const sectionUrl = new URL(`/library/sections/${libraryId}`, base);
    sectionUrl.searchParams.set('includeDetails', '1');
    const sectionResponse = await fetchImpl(sectionUrl, { method: 'GET', redirect: 'manual',
      headers: { 'X-Plex-Token': token, Accept: 'application/json',
        'X-Plex-Client-Identifier': 'negev-availability-observer' },
      signal: AbortSignal.timeout(timeoutMs) });
    if (sectionResponse.status !== 200) return unavailable();
    const section = (await readBoundedJson(sectionResponse, 100_000))?.MediaContainer;
    const type = kind === 'episode' ? '4' : '1';
    if (integer(section?.librarySectionID) !== integer(libraryId) ||
        !Array.isArray(section.Directory) || section.Directory.length > 100) return unavailable();
    const pivots = section.Directory.filter((entry) => String(entry?.type) === type);
    let pivotKey;
    if (pivots.length === 1 && typeof pivots[0].key === 'string') {
      pivotKey = pivots[0].key;
    } else if (pivots.length === 0 &&
        section.Directory.filter((entry) => entry?.key === 'all').length === 1 &&
        section.Directory.filter((entry) => entry?.key === `search?type=${type}`).length === 1) {
      // Plex can advertise a generic all link and a separate typed search
      // link. Require both before constructing the scoped all-page URL.
      pivotKey = `/library/sections/${libraryId}/all?type=${type}`;
    } else return unavailable();
    const url = new URL(pivotKey, base);
    if (url.origin !== base.origin || url.username || url.password || url.hash ||
        url.pathname !== `/library/sections/${libraryId}/all` ||
        [...url.searchParams.keys()].length !== 1 ||
        url.searchParams.get('type') !== type) return unavailable();
    url.searchParams.set('sort', 'addedAt:desc');
    if (includeCards) {
      url.searchParams.set('includeMedia', '1');
      url.searchParams.set('includeGuids', '1');
    }
    const response = await fetchImpl(url, { method: 'GET', redirect: 'manual',
      headers: { 'X-Plex-Token': token, Accept: 'application/json',
        'X-Plex-Client-Identifier': 'negev-availability-observer',
        'X-Plex-Container-Start': String(offset),
        'X-Plex-Container-Size': String(pageSize) },
      signal: AbortSignal.timeout(timeoutMs) });
    if (response.status !== 200) return unavailable();
    hasResponseStart = response.headers?.has?.('x-plex-container-start') ?? false;
    hasResponseTotal = response.headers?.has?.('x-plex-container-total-size') ?? false;
    if (hasResponseStart) responseStart = integer(response.headers.get('x-plex-container-start'));
    if (hasResponseTotal) responseTotal = integer(response.headers.get('x-plex-container-total-size'));
    body = await readBoundedJson(response, 1_000_000);
  } catch { return unavailable(); }
  const container = body?.MediaContainer;
  const hasBodyStart = container != null && Object.hasOwn(container, 'offset');
  const bodyStart = hasBodyStart ? integer(container.offset) : null;
  const hasBodyTotal = container != null && Object.hasOwn(container, 'totalSize');
  const bodyTotal = hasBodyTotal ? integer(container.totalSize) : null;
  const totalSize = hasBodyTotal ? bodyTotal : responseTotal;
  const size = integer(container?.size);
  const metadata = container?.Metadata === undefined && size === 0 &&
    totalSize === 0 && integer(offset) === 0 ? [] : container?.Metadata;
  if (integer(container?.librarySectionID) !== integer(libraryId) ||
      (!hasBodyStart && !hasResponseStart) ||
      (hasBodyStart && bodyStart !== integer(offset)) ||
      (hasResponseStart && responseStart !== integer(offset)) ||
      (hasBodyTotal && bodyTotal === null) ||
      (hasResponseTotal && responseTotal === null) ||
      (hasBodyTotal && hasResponseTotal && bodyTotal !== responseTotal) ||
      size === null || size > pageSize ||
      (totalSize !== null && totalSize < offset + size) ||
      !Array.isArray(metadata) ||
      metadata.length !== size) return unavailable();
  const keys = [];
  const seen = new Set();
  for (const item of metadata) {
    const key = integer(item?.ratingKey, 1);
    const itemLibrary = item?.librarySectionID === undefined ? integer(libraryId) :
      integer(item.librarySectionID, 1);
    if (key === null || seen.has(key) || item?.type !== kind ||
        itemLibrary !== integer(libraryId)) return unavailable();
    seen.add(key);
    keys.push(key);
  }
  const cards = includeCards ? metadata.map((item) => {
    const parsed = parsePlexCardParts({ item,
      containerLibraryId: container.librarySectionID,
      ratingKey: item.ratingKey, expectedType: kind, libraryId });
    return parsed.state === 'ok' ? parsed : null;
  }) : null;
  return { state: 'page', libraryId: integer(libraryId), kind,
    offset: integer(offset), totalSize, keys, complete: false,
    ...(includeCards ? { cards } : {}) };
}
