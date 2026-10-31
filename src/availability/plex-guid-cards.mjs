import { readBoundedJson } from '../http/bounded-response.mjs';

const unavailable = () => ({ state: 'unavailable' });
const integer = (value, minimum = 0) => {
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) value = Number(value);
  return Number.isSafeInteger(value) && value >= minimum ? value : null;
};

// This is a positive-only shortcut to known Plex cards. A matching key must
// still be read and joined to exact Shoko identity and physical bytes. An
// empty response is never a complete-library or acquisition absence proof.
export async function readPlexGuidCards({ baseUrl, token, libraryId, kind,
  guid, fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  let base;
  try { base = new URL(baseUrl); } catch { throw new TypeError('Invalid Plex URL'); }
  const expectedGuid = kind === 'episode'
    ? /^tv\.plex\.agents\.custom\.shoko:\/\/episode\/e[1-9]\d*$/.test(guid)
    : kind === 'movie' && /^tmdb:\/\/[1-9]\d*$/.test(guid);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
      base.search || base.hash || base.pathname !== '/' ||
      typeof token !== 'string' || !token || /[\r\n]/.test(token) ||
      integer(libraryId, 1) === null || !expectedGuid ||
      typeof fetchImpl !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError('Invalid Plex GUID lookup');
  }
  let body, startHeader = null, totalHeader = null;
  try {
    const url = new URL(`/library/sections/${libraryId}/all`, base);
    url.searchParams.set('type', kind === 'episode' ? '4' : '1');
    url.searchParams.set('guid', guid);
    const response = await fetchImpl(url, { method: 'GET', redirect: 'manual',
      headers: { 'X-Plex-Token': token, Accept: 'application/json',
        'X-Plex-Client-Identifier': 'negev-availability-observer',
        'X-Plex-Container-Start': '0', 'X-Plex-Container-Size': '10' },
      signal: AbortSignal.timeout(timeoutMs) });
    if (response.status !== 200) return unavailable();
    if (response.headers?.has?.('x-plex-container-start')) {
      startHeader = integer(response.headers.get('x-plex-container-start'));
      if (startHeader === null) return unavailable();
    }
    if (response.headers?.has?.('x-plex-container-total-size')) {
      totalHeader = integer(response.headers.get('x-plex-container-total-size'));
      if (totalHeader === null) return unavailable();
    }
    body = await readBoundedJson(response, 500_000);
  } catch { return unavailable(); }
  const container = body?.MediaContainer;
  const start = integer(container?.offset);
  const total = integer(container?.totalSize);
  const size = integer(container?.size);
  if (integer(container?.librarySectionID) !== integer(libraryId) ||
      (start === null && startHeader === null) ||
      (start !== null && start !== 0) || (startHeader !== null && startHeader !== 0) ||
      (total === null && totalHeader === null) ||
      (total !== null && totalHeader !== null && total !== totalHeader) ||
      (total ?? totalHeader) > 10 || size === null || size > 10 ||
      size !== (total ?? totalHeader) || !Array.isArray(container.Metadata) ||
      container.Metadata.length !== size) return unavailable();
  const cards = [];
  const keys = new Set();
  for (const item of container.Metadata) {
    const ratingKey = integer(item?.ratingKey, 1);
    const exactGuid = item?.guid === guid ||
      (kind === 'movie' && Array.isArray(item?.Guid) &&
        item.Guid.length <= 50 && item.Guid.some((entry) => entry?.id === guid));
    if (ratingKey === null || keys.has(ratingKey) ||
        integer(item?.librarySectionID, 1) !== integer(libraryId) ||
        item?.type !== kind || !exactGuid) return unavailable();
    keys.add(ratingKey);
    cards.push({ libraryId: integer(libraryId), ratingKey, kind });
  }
  return { state: 'cards', cards, complete: true };
}
