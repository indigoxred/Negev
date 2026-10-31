const SERIES_TYPES = new Set(['TV', 'TVSeries', 'OVA', 'TVSpecial', 'Web', 'Other']);

async function readJson(url, apiKey, fetchImpl, timeoutMs) {
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status !== 200) return { status: response.status };
    const body = await response.text();
    if (body.length > 2_000_000) return { status: 0 };
    return { status: 200, value: JSON.parse(body) };
  } catch { return { status: 0 }; }
}

// Reads only metadata Shoko already has. An unowned title normally has no
// detail row; this function never invokes Shoko's metadata refresh action.
export async function loadAniDbDetail({
  baseUrl, apiKey, anidbId, page = 1, pageSize = 100,
  fetchImpl = fetch, timeoutMs = 10_000,
}) {
  if (!Number.isSafeInteger(anidbId) || anidbId <= 0 ||
      !Number.isSafeInteger(page) || page < 1 || page > 1000 ||
      !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100 ||
      typeof apiKey !== 'string' || !apiKey ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError('Invalid AniDB detail request');
  }
  let base;
  try { base = new URL(baseUrl); } catch { throw new TypeError('Invalid Shoko base URL'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new TypeError('Invalid Shoko base URL');
  }

  const detailUrl = new URL(`/api/v3/Series/AniDB/${anidbId}`, base);
  const detail = await readJson(detailUrl, apiKey, fetchImpl, timeoutMs);
  if (detail.status === 404) return { state: 'detail_pending', anidbId };
  if (detail.status !== 200) return { state: 'unavailable' };
  const anime = detail.value;
  if (anime?.ID !== anidbId || typeof anime.Title !== 'string' || !anime.Title.trim()) {
    return { state: 'unavailable' };
  }
  if ((anime.AirDate != null && typeof anime.AirDate !== 'string') ||
      (anime.EndDate != null && typeof anime.EndDate !== 'string') ||
      (anime.EpisodeCount != null && (!Number.isSafeInteger(anime.EpisodeCount) || anime.EpisodeCount < 0)) ||
      (anime.Restricted != null && typeof anime.Restricted !== 'boolean')) {
    return { state: 'unavailable' };
  }
  const kind = anime.Type === 'Movie' ? 'movie' : SERIES_TYPES.has(anime.Type) ? 'series' : null;
  if (!kind) return { state: 'detail_pending', anidbId };

  const episodesUrl = new URL(`/api/v3/Series/AniDB/${anidbId}/Episode`, base);
  episodesUrl.searchParams.set('page', String(page));
  episodesUrl.searchParams.set('pageSize', String(pageSize));
  episodesUrl.searchParams.set('includeMissing', 'true');
  episodesUrl.searchParams.set('includeUnaired', 'true');
  const response = await readJson(episodesUrl, apiKey, fetchImpl, timeoutMs);
  if (response.status === 404) return { state: 'detail_pending', anidbId };
  if (response.status !== 200) return { state: 'unavailable' };
  const data = response.value;
  if (!Number.isSafeInteger(data?.Total) || data.Total < 0 ||
      !Array.isArray(data.List) || data.List.length > pageSize ||
      data.List.some((ep) => !Number.isSafeInteger(ep?.ID) || ep.ID <= 0 ||
        ep.AnimeID !== anidbId || !Number.isSafeInteger(ep.EpisodeNumber) || ep.EpisodeNumber <= 0 ||
        typeof ep.Type !== 'string' || typeof ep.Title !== 'string' ||
        (ep.AirDate != null && typeof ep.AirDate !== 'string'))) {
    return { state: 'unavailable' };
  }
  return {
    state: 'details', anidbId, title: anime.Title, kind,
    airDate: anime.AirDate ?? null, endDate: anime.EndDate ?? null,
    episodeCount: anime.EpisodeCount ?? null, restricted: anime.Restricted ?? null,
    total: data.Total, page,
    complete: page === 1 && data.List.length === data.Total,
    nextPage: page * pageSize < data.Total ? page + 1 : null,
    episodes: data.List.map((ep) => ({ id: ep.ID, number: ep.EpisodeNumber,
      type: ep.Type, title: ep.Title, airDate: ep.AirDate ?? null })),
    requestable: false,
  };
}

