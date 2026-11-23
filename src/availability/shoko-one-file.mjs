import { readBoundedJson } from '../http/bounded-response.mjs';
import { normalizeShokoFile } from './shoko-file-page.mjs';

// Targeted event follow-up. A 404 is inconclusive during Shoko's import
// pipeline and never by itself removes an availability claim.
export async function readShokoOneFile({ baseUrl, apiKey, fileId,
  includePaths = false, fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  let base;
  try { base = new URL(baseUrl); } catch { throw new TypeError('Invalid Shoko URL'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
      base.search || base.hash || base.pathname !== '/' ||
      typeof apiKey !== 'string' || !apiKey ||
      !Number.isSafeInteger(fileId) || fileId < 1 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 ||
      typeof includePaths !== 'boolean' || typeof fetchImpl !== 'function') throw new TypeError('Invalid Shoko file observation');
  const url = new URL(`/api/v3/File/${fileId}`, base);
  url.searchParams.append('include', includePaths ? 'XRefs,AbsolutePaths' : 'XRefs');
  try {
    const response = await fetchImpl(url, { method: 'GET', redirect: 'manual',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs) });
    if (response.status !== 200) return { state: 'unavailable' };
    const raw=await readBoundedJson(response,100_000);
    const item = normalizeShokoFile(raw);
    const observedPaths=includePaths&&Array.isArray(raw?.Locations)&&raw.Locations.length<=20
      ? raw.Locations.filter(l=>l?.FileID===fileId&&l.IsAccessible===true&&Number.isSafeInteger(l.ManagedFolderID)&&l.ManagedFolderID>0&&typeof l.RelativePath==='string')
        .map(l=>({ManagedFolderID:l.ManagedFolderID,RelativePath:l.RelativePath.replace(/^\//,'')})) : [];
    return item?.fileId === fileId ? { state: 'file', item, ...(includePaths?{observedPaths}:{}) } : { state: 'unavailable' };
  } catch { return { state: 'unavailable' }; }
}
