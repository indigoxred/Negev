import path from 'node:path';
import { readBoundedJson } from '../http/bounded-response.mjs';

const unavailable = () => ({ state: 'unavailable' });
const positive = (value) => {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};
const validPath = (value) => typeof value === 'string' && value.length <= 4096 &&
  path.posix.isAbsolute(value) && path.posix.normalize(value) === value &&
  !/[\0\r\n\\]/.test(value);

// Shared by exact-card reads and scoped page indexing. A page row is only an
// index candidate; final availability still re-reads its exact card.
export function parsePlexCardParts({ item, containerLibraryId,
  ratingKey, expectedType, libraryId }) {
  if (positive(item?.ratingKey) !== positive(ratingKey) ||
      item.type !== expectedType) return unavailable();
  const itemLibrary = positive(item.librarySectionID);
  const containerLibrary = positive(containerLibraryId);
  if ((itemLibrary !== null && itemLibrary !== positive(libraryId)) ||
      (containerLibrary !== null && containerLibrary !== positive(libraryId)) ||
      (itemLibrary === null && containerLibrary === null) ||
      !Array.isArray(item.Media) || item.Media.length > 20) return unavailable();
  if (item.Media.length === 0) return { state: 'no_parts' };
  const parts = [];
  const seen = new Set();
  const itemGuid = typeof item.guid === 'string' && item.guid.length <= 512
    ? item.guid : null;
  const showGuid = typeof item.grandparentGuid === 'string' &&
    item.grandparentGuid.length <= 512 ? item.grandparentGuid : null;
  const externalGuids = Array.isArray(item.Guid) && item.Guid.length <= 50 &&
    item.Guid.every((guid) => typeof guid?.id === 'string' &&
      guid.id.length > 0 && guid.id.length <= 512 &&
      !/[\r\n\0]/.test(guid.id)) ? item.Guid.map((guid) => guid.id) : [];
  for (const media of item.Media) {
    if (!Array.isArray(media?.Part) || media.Part.length === 0 || media.Part.length > 20) {
      return unavailable();
    }
    for (const part of media.Part) {
      const partId = positive(part?.id);
      const size = positive(part?.size);
      if (partId === null || size === null || !validPath(part.file) || seen.has(partId)) {
        return unavailable();
      }
      seen.add(partId);
      parts.push({ partId, plexPath: part.file, size,
        libraryId: positive(libraryId), cardType: expectedType,
        itemGuid, showGuid, externalGuids });
    }
  }
  return { state: 'ok', complete: true, parts };
}

// Read one known Plex rating key. A missing record is not proof that a Shoko
// file is absent; the caller must discover keys from scoped Plex evidence.
export async function readPlexItemParts({ baseUrl, token, ratingKey, expectedType,
  libraryId, fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  let base;
  try { base = new URL(baseUrl); } catch { throw new TypeError('Invalid Plex URL'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
      base.search || base.hash || base.pathname !== '/' ||
      typeof token !== 'string' || !token || /[\r\n]/.test(token) ||
      positive(ratingKey) === null || positive(libraryId) === null ||
      !['episode', 'movie'].includes(expectedType) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 ||
      typeof fetchImpl !== 'function') throw new TypeError('Invalid Plex item observation');
  let body;
  try {
    const url = new URL(`/library/metadata/${ratingKey}`, base);
    const response = await fetchImpl(url, { method: 'GET', redirect: 'manual',
      headers: { 'X-Plex-Token': token, Accept: 'application/json',
        'X-Plex-Client-Identifier': 'negev-availability-observer' },
      signal: AbortSignal.timeout(timeoutMs) });
    if (response.status === 404) return { state: 'not_found' };
    if (response.status !== 200) return unavailable();
    body = await readBoundedJson(response, 2_000_000);
  } catch { return unavailable(); }
  const container = body?.MediaContainer;
  if (positive(container?.size) !== 1 || !Array.isArray(container.Metadata) ||
      container.Metadata.length !== 1) return unavailable();
  return parsePlexCardParts({ item: container.Metadata[0],
    containerLibraryId: container.librarySectionID,
    ratingKey, expectedType, libraryId });
}
