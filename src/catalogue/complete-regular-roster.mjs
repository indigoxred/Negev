// Count a season only after every AniDB entry page has been seen. This reads
// metadata, not media, and never turns a partial or changing roster into proof.
export async function completeRegularRoster({ first, loadPage, maxPages = 5,
  deadlineMs = 1_400, now = Date.now, includeEpisodes = false } = {}) {
  if (typeof loadPage !== 'function' || typeof now !== 'function' ||
      !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 10 ||
      !Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 3_000) {
    throw new TypeError('Invalid regular roster reader');
  }
  const invalid = (value, page) => value?.state !== 'details' ||
    value.anidbId !== first?.anidbId || value.kind !== 'series' ||
    value.title !== first?.title || value.total !== first?.total ||
    value.episodeCount !== first?.episodeCount || value.page !== page ||
    !Number.isSafeInteger(value.total) || value.total < 0 ||
    !Array.isArray(value.episodes) || value.episodes.length > 100 ||
    !Number.isSafeInteger(value?.anidbId) || value.anidbId < 1 ||
    ![null, page + 1].includes(value.nextPage);
  if (invalid(first, 1)) return null;
  const started = now();
  const seen = new Set();
  const regularIds = [];
  const regularEpisodes = [];
  let count = 0;
  let current = first;
  for (let page = 1; page <= maxPages; page++) {
    if (invalid(current, page) || current.episodes.length === 0 &&
        !(page === 1 && current.total === 0)) return null;
    for (const episode of current.episodes) {
      if (!Number.isSafeInteger(episode?.id) || episode.id < 1 ||
          seen.has(episode.id) || typeof episode.type !== 'string') return null;
      seen.add(episode.id);
      if (episode.type === 'Episode') {
        regularIds.push(episode.id);
        if (includeEpisodes) regularEpisodes.push(episode);
      }
    }
    count += current.episodes.length;
    if (count > current.total) return null;
    if (current.nextPage === null) {
      if (count !== current.total ||
          Number.isSafeInteger(first.episodeCount) &&
          regularIds.length !== first.episodeCount) return null;
      return includeEpisodes ? regularEpisodes : regularIds;
    }
    if (count === current.total || page === maxPages) return null;
    const remaining = deadlineMs - (now() - started);
    if (remaining < 1) return null;
    try { current = await loadPage(page + 1, remaining); }
    catch { return null; }
  }
  return null;
}
