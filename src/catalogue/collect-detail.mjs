// Assemble Shoko's cached AniDB episode pages without claiming that a
// partial or changing catalogue is complete.
export async function collectAniDbDetail({ anidbId, loadPage, maxPages = 20 }) {
  if (!Number.isSafeInteger(anidbId) || anidbId <= 0 ||
      typeof loadPage !== 'function' || !Number.isSafeInteger(maxPages) ||
      maxPages < 1 || maxPages > 100) throw new TypeError('Invalid detail collection');
  const episodes = [];
  const ids = new Set();
  const invalid = { state: 'invalid_detail_evidence' };
  let first;
  for (let page = 1; page <= maxPages; page++) {
    let result;
    try { result = await loadPage({ anidbId, page }); }
    catch { return { state: 'unavailable' }; }
    if (page === 1 && result?.state === 'detail_pending' && result.anidbId === anidbId) return result;
    if (result?.state === 'unavailable' || result?.state === 'detail_pending') return { state: 'unavailable' };
    if (result?.state !== 'details' || result.anidbId !== anidbId || result.page !== page ||
        !Number.isSafeInteger(result.total) || result.total < 0 ||
        !Array.isArray(result.episodes) || result.episodes.length === 0 ||
        !['movie', 'series'].includes(result.kind) ||
        typeof result.title !== 'string' || !result.title.trim()) return invalid;
    if (!first) first = result;
    if (result.total !== first.total || result.title !== first.title || result.kind !== first.kind ||
        (result.airDate ?? null) !== (first.airDate ?? null) ||
        (result.endDate ?? null) !== (first.endDate ?? null) ||
        (result.episodeCount ?? null) !== (first.episodeCount ?? null) ||
        (result.restricted ?? null) !== (first.restricted ?? null)) {
      return invalid;
    }
    for (const episode of result.episodes) {
      if (!Number.isSafeInteger(episode?.id) || episode.id <= 0 || ids.has(episode.id) ||
          !Number.isSafeInteger(episode.number) || episode.number <= 0 ||
          typeof episode.type !== 'string' || typeof episode.title !== 'string') {
        return invalid;
      }
      ids.add(episode.id);
      episodes.push(episode);
    }
    if (episodes.length > result.total) return invalid;
    if (page === 1 && result.complete !== (episodes.length === result.total && result.nextPage === null)) {
      return invalid;
    }
    if (result.nextPage === null) {
      if (episodes.length !== result.total) return invalid;
      return { state: 'details', anidbId, title: first.title, kind: first.kind,
        airDate: first.airDate ?? null, endDate: first.endDate ?? null,
        episodeCount: first.episodeCount ?? null, restricted: first.restricted ?? null,
        total: first.total, page: 1, complete: true, nextPage: null,
        episodes, requestable: false };
    }
    if (result.nextPage !== page + 1 || episodes.length === result.total) return invalid;
  }
  return { state: 'partial_detail', anidbId, reason: 'page_limit' };
}
