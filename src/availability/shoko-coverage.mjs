// Availability interpretation only. Callers validate every raw anime/episode
// identity before using this projection; empty links cannot hide wrong IDs.
export function normalizeShokoCoverage(refs) {
  if (!Array.isArray(refs) || refs.length < 1 || refs.length > 100 ||
      refs.some(ref => !Number.isSafeInteger(ref?.AnidbEpisodeID) || ref.AnidbEpisodeID < 1 ||
        !Object.hasOwn(ref,'PercentageStart') || !Object.hasOwn(ref,'PercentageEnd') ||
        ((ref.PercentageStart === null) !== (ref.PercentageEnd === null)) ||
        (ref.PercentageStart !== null && (!Number.isFinite(ref.PercentageStart) ||
          !Number.isFinite(ref.PercentageEnd) || ref.PercentageStart < 0 || ref.PercentageEnd > 100 ||
          ref.PercentageStart > ref.PercentageEnd ||
          (ref.PercentageStart === ref.PercentageEnd && ref.PercentageStart !== 0)))) ||
      new Set(refs.map(ref=>ref.AnidbEpisodeID)).size !== refs.length) return null;
  return refs.map(ref=>({episodeId:ref.AnidbEpisodeID,
    start:ref.PercentageStart ?? 0,end:ref.PercentageEnd ?? 100}));
}

// A Release's 0–0 can be a serialization artifact. Only the same fetched
// local file's complete AniDB links may replace it; absent local ranges keep
// the empty link empty. No title or episode-number inference is involved.
export function localRangeRelease(file, anidbId) {
  const refs=file?.Release?.CrossReferences;
  if (!normalizeShokoCoverage(refs) || !Array.isArray(file.SeriesIDs) ||
    file.SeriesIDs.length<1 || file.SeriesIDs.length>100) return null;
  const ranges=new Map();
  for(const series of file.SeriesIDs) {
    if(series?.SeriesID?.AniDB!==anidbId || !Array.isArray(series.EpisodeIDs) || series.EpisodeIDs.length>500) return null;
    for(const episode of series.EpisodeIDs) {
      const id=episode?.AniDB,start=episode?.Percentage?.Start,end=episode?.Percentage?.End;
      if(episode?.Source!=='AniDB' || !Number.isSafeInteger(id) || id<1 || ranges.has(id) ||
        !Number.isFinite(start) || !Number.isFinite(end) || start<0 || end>100 || start>=end) return null;
      ranges.set(id,{start,end});
    }
  }
  if(ranges.size!==refs.length || refs.some(ref=>ref.AnidbAnimeID!==anidbId || !ranges.has(ref.AnidbEpisodeID))) return null;
  return {...file.Release,CrossReferences:refs.map(ref=>ref.PercentageStart===0 && ref.PercentageEnd===0
    ? {...ref,PercentageStart:ranges.get(ref.AnidbEpisodeID).start,PercentageEnd:ranges.get(ref.AnidbEpisodeID).end} : ref)};
}
