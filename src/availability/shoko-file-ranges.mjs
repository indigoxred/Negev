import { readBoundedJson } from '../http/bounded-response.mjs';
// Availability only: recover 0..0 serialization from the same immutable local file.
export async function readLocalFileRanges({ base, apiKey, file, anidbId, ed2k, fetchImpl, timeoutMs }) {
  try {
    const url = new URL('/api/v3/File/'+file.ID, base); url.searchParams.set('include','XRefs');
    const response = await fetchImpl(url,{method:'GET',redirect:'manual',headers:{Authorization:'Bearer '+apiKey,Accept:'application/json'},signal:AbortSignal.timeout(timeoutMs)});
    if(response.status !== 200) return null;
    const exact = await readBoundedJson(response,2_000_000);
    if(exact?.ID !== file.ID || exact.Size !== file.Size || exact.IsIgnored !== false || !exact.Hashes?.some(h=>h?.Type === 'ED2K' && h.Value === ed2k) || !Array.isArray(exact.SeriesIDs) || exact.SeriesIDs.length < 1 || exact.SeriesIDs.length > 100) return null;
    const ranges = new Map();
    for(const series of exact.SeriesIDs) {
      if(series?.SeriesID?.AniDB !== anidbId || !Array.isArray(series.EpisodeIDs) || series.EpisodeIDs.length > 500) return null;
      for(const episode of series.EpisodeIDs) {
        const id=episode?.AniDB, start=episode?.Percentage?.Start, end=episode?.Percentage?.End;
        if(episode?.Source !== 'AniDB' || !Number.isSafeInteger(id) || id<1 || ranges.has(id) || !Number.isFinite(start) || !Number.isFinite(end) || start<0 || end>100 || start>=end) return null;
        ranges.set(id,{start,end});
      }
    }
    if(ranges.size !== file.Release.CrossReferences.length || file.Release.CrossReferences.some(r=>!ranges.has(r.AnidbEpisodeID))) return null;
    return {...file.Release,CrossReferences:file.Release.CrossReferences.map(ref=>{const range=ranges.get(ref.AnidbEpisodeID); if(ref.PercentageStart !== 0 || ref.PercentageEnd !== 0) return ref; return {...ref,PercentageStart:range.start,PercentageEnd:range.end};})};
  } catch { return null; }
}
