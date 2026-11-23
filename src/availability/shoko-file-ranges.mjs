import { readBoundedJson } from '../http/bounded-response.mjs';
import { localRangeRelease } from './shoko-coverage.mjs';
// Availability only: recover 0..0 serialization from the same immutable local file.
export async function readLocalFileRanges({ base, apiKey, file, anidbId, ed2k, fetchImpl, timeoutMs }) {
  try {
    const url = new URL('/api/v3/File/'+file.ID, base); url.searchParams.set('include','XRefs');
    const response = await fetchImpl(url,{method:'GET',redirect:'manual',headers:{Authorization:'Bearer '+apiKey,Accept:'application/json'},signal:AbortSignal.timeout(timeoutMs)});
    if(response.status !== 200) return null;
    const exact = await readBoundedJson(response,2_000_000);
    if(exact?.ID !== file.ID || exact.Size !== file.Size || exact.IsIgnored !== false || !exact.Hashes?.some(h=>h?.Type === 'ED2K' && h.Value === ed2k)) return null;
    return localRangeRelease({...exact,Release:file.Release},anidbId);
  } catch { return null; }
}
