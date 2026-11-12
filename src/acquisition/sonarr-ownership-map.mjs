const validId = (value) => Number.isSafeInteger(value) && value > 0;
const held = (reason) => ({ state: 'held', reason });

// This is an exclusion map, not an episode mapping. Every AniDB installment
// sharing a monitored TVDB series is held from Negev acquisition. A target
// explicitly filed on a different TVDB series also counts as an overlap.
export function mapSonarrOwnership(map, series) {
  if (map?.version !== 2 || !Array.isArray(map.anime) ||
      map.anime.length < 1 || map.anime.length > 100_000 ||
      !Array.isArray(series) || series.length > 5_000) {
    return held('ownership_map_invalid');
  }
  const watched = new Set();
  for (const item of series) {
    if (!validId(item?.id) || typeof item.monitored !== 'boolean') {
      return held('sonarr_response_invalid');
    }
    if (!item.monitored) continue;
    if (!validId(item.tvdbId)) return held('sonarr_identity_unmapped');
    watched.add(item.tvdbId);
  }
  const matched = new Set();
  const ownedAnidbIds = new Set();
  const knownAnidbIds = new Set();
  for (const item of map.anime) {
    if (!validId(item?.anidb_id) ||
        (item.tvdb_id !== undefined && item.tvdb_id !== null &&
          !validId(item.tvdb_id)) ||
        (item.episodes !== undefined && !Array.isArray(item.episodes))) {
      return held('ownership_map_invalid');
    }
    knownAnidbIds.add(item.anidb_id);
    const ids = new Set(validId(item.tvdb_id) ? [item.tvdb_id] : []);
    for (const run of item.episodes ?? []) {
      if (!Array.isArray(run?.tvdb)) continue;
      for (const target of run.tvdb) {
        const id = target?.series ?? item.tvdb_id;
        if (validId(id)) ids.add(id);
      }
    }
    for (const id of ids) {
      if (!watched.has(id)) continue;
      matched.add(id);
      ownedAnidbIds.add(item.anidb_id);
    }
  }
  if (matched.size !== watched.size) return held('sonarr_identity_unmapped');
  return { state: 'ready', monitoredSeries: watched.size,
    ownedAnidbIds, knownAnidbIds };
}
