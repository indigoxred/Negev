import path from 'node:path';
import { readBoundedJson } from '../http/bounded-response.mjs';

const validId = (value) => Number.isSafeInteger(value) && value > 0;
const unavailable = () => ({ state: 'unavailable' });
const validText = (value) => typeof value === 'string' &&
  value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
const validRoot = (value) => typeof value === 'string' &&
  value !== '/' && value.length <= 4_096 &&
  path.posix.isAbsolute(value) && path.posix.normalize(value) === value &&
  !/[\\\x00-\x1f\x7f]/.test(value);

// The stock Plex sections-list route reports each library's agent, scanner
// and source roots. This is a bounded configuration observation only: a
// matching source does not prove that a particular title or file is absent.
export async function readPlexLibrarySources({ baseUrl, token, libraryIds,
  fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  let base;
  try { base = new URL(baseUrl); }
  catch { throw new TypeError('Invalid Plex source URL'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username ||
      base.password || base.pathname !== '/' || base.search || base.hash ||
      typeof token !== 'string' || !token || /[\r\n]/.test(token) ||
      !Array.isArray(libraryIds) || libraryIds.length < 1 ||
      libraryIds.length > 4 || libraryIds.some((id) => !validId(id)) ||
      new Set(libraryIds).size !== libraryIds.length ||
      typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError('Invalid Plex source scope');
  }
  let body;
  try {
    const response = await fetchImpl(new URL('/library/sections', base), {
      method: 'GET', redirect: 'manual',
      headers: { 'X-Plex-Token': token, Accept: 'application/json',
        'X-Plex-Client-Identifier': 'negev-availability-observer' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status !== 200) return unavailable();
    body = (await readBoundedJson(response, 500_000))?.MediaContainer;
  } catch { return unavailable(); }
  if (!Array.isArray(body?.Directory) || body.Directory.length > 100 ||
      !Number.isSafeInteger(body.size) ||
      body.size !== body.Directory.length) return unavailable();
  const sections = [];
  for (const libraryId of libraryIds) {
    const matches = body.Directory.filter((row) =>
      String(row?.key) === String(libraryId));
    if (matches.length !== 1) return unavailable();
    const row = matches[0];
    if (!['show', 'movie'].includes(row.type) ||
        !validText(row.agent) || !validText(row.scanner) ||
        !Array.isArray(row.Location) || row.Location.length < 1 ||
        row.Location.length > 16) return unavailable();
    const roots = row.Location.map((entry) => entry?.path);
    if (roots.some((root) => !validRoot(root)) ||
        new Set(roots).size !== roots.length) return unavailable();
    sections.push({ libraryId, type: row.type, agent: row.agent,
      scanner: row.scanner, roots });
  }
  return { state: 'source_snapshot', sections };
}
