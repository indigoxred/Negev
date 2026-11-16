import path from 'node:path';
import { readBoundedJson } from '../http/bounded-response.mjs';

export async function readShokoPathFile({ baseUrl, apiKey, sourcePath,
  fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  let base;
  try { base = new URL(baseUrl); }
  catch { throw new TypeError('Invalid Shoko file lookup'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username ||
      base.password || base.search || base.hash ||
      typeof apiKey !== 'string' || !apiKey ||
      typeof sourcePath !== 'string' ||
      !path.posix.isAbsolute(sourcePath) ||
      path.posix.normalize(sourcePath) !== sourcePath ||
      /[\\\0\r\n]/.test(sourcePath) ||
      typeof fetchImpl !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
      timeoutMs > 60_000) throw new TypeError('Invalid Shoko file lookup');
  try {
    const url = new URL('/api/v3/File/PathEndsWith', base);
    url.searchParams.set('path', sourcePath);
    url.searchParams.set('include', 'AbsolutePaths');
    url.searchParams.append('include', 'XRefs');
    url.searchParams.set('limit', '100');
    const response = await fetchImpl(url, { method: 'GET',
      redirect: 'manual', headers: {
        Authorization: `Bearer ${apiKey}`, Accept: 'application/json',
      }, signal: AbortSignal.timeout(timeoutMs) });
    if (response.status !== 200) return { state: 'unavailable' };
    const items = await readBoundedJson(response, 2_000_000);
    if (!Array.isArray(items) || items.length > 100) {
      return { state: 'unavailable' };
    }
    return { state: 'files', items };
  } catch { return { state: 'unavailable' }; }
}
