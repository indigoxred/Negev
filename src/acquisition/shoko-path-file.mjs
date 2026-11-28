import path from 'node:path';
import { cancelResponseBody, readBoundedJson } from '../http/bounded-response.mjs';

export async function readShokoPathFile({ baseUrl, apiKey, sourcePath, fileId,
  fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  let base;
  try { base = new URL(baseUrl); }
  catch { throw new TypeError('Invalid Shoko file lookup'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username ||
      base.password || base.search || base.hash ||
      typeof apiKey !== 'string' || !apiKey ||
      (fileId === undefined ? (typeof sourcePath !== 'string' ||
        !path.posix.isAbsolute(sourcePath) || path.posix.normalize(sourcePath) !== sourcePath ||
        /[\\\0\r\n]/.test(sourcePath)) :
        (!Number.isSafeInteger(fileId) || fileId < 1 || sourcePath !== undefined)) ||
      typeof fetchImpl !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
      timeoutMs > 60_000) throw new TypeError('Invalid Shoko file lookup');
  try {
    const url = new URL(fileId === undefined ? '/api/v3/File/PathEndsWith' : `/api/v3/File/${fileId}`, base);
    if (fileId === undefined) url.searchParams.set('path', sourcePath);
    url.searchParams.set('include', 'AbsolutePaths');
    url.searchParams.append('include', 'XRefs');
    url.searchParams.set('limit', '100');
    const response = await fetchImpl(url, { method: 'GET',
      redirect: 'manual', headers: {
        Authorization: `Bearer ${apiKey}`, Accept: 'application/json',
      }, signal: AbortSignal.timeout(timeoutMs) });
    if (response.status !== 200) await cancelResponseBody(response);
    if (response.status !== 200) return { state: 'unavailable' };
    const raw = await readBoundedJson(response, 2_000_000);
    const items = fileId === undefined ? raw : raw?.ID === fileId ? [raw] : null;
    if (!Array.isArray(items) || items.length > 100) {
      return { state: 'unavailable' };
    }
    return { state: 'files', items };
  } catch { return { state: 'unavailable' }; }
}

export function readShokoFileById(options) {
  if (!Number.isSafeInteger(options?.fileId) || options.fileId < 1) throw new TypeError('Invalid Shoko file ID');
  return readShokoPathFile(options);
}
