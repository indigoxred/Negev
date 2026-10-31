import { collectAniDbDetail } from '../catalogue/collect-detail.mjs';

const held = (reason) => ({ state: 'held', reason });

// This joins a saved exact request to a current Shoko title before searching.
// Neither a title nor a Prowlarr hit proves the release's AniDB file identity.
export function createRequestCandidateDiscovery({ readRequest, loadDetail, searchReleases }) {
  if (typeof readRequest !== 'function' || typeof loadDetail !== 'function' ||
      typeof searchReleases !== 'function') {
    throw new TypeError('Invalid request discovery configuration');
  }
  return async ({ requestId }) => {
    if (!Number.isSafeInteger(requestId) || requestId <= 0) return held('invalid_request');
    let request;
    try { request = readRequest(requestId); } catch { return held('request_unavailable'); }
    if (!request) return held('request_missing');
    if (request.id !== requestId || request.status !== 'held' ||
        !Number.isSafeInteger(request.anidbId) || request.anidbId <= 0 ||
        !['series', 'movie'].includes(request.kind) ||
        !Array.isArray(request.episodeIds) || request.episodeIds.length === 0 ||
        request.episodeIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
      return held('request_unavailable');
    }
    const detail = await collectAniDbDetail({ anidbId: request.anidbId, loadPage: loadDetail });
    if (detail.state !== 'details') return held('detail_unavailable');
    if (detail.kind !== request.kind) return held('identity_changed');
    if (detail.restricted !== false) return held('restricted_or_unverified');
    const episodeIds = new Set(detail.episodes.map((episode) => episode.id));
    if (request.episodeIds.some((id) => !episodeIds.has(id))) return held('target_missing');
    if (detail.title.length > 120) return held('query_too_long');
    let result;
    try { result = await searchReleases({ query: detail.title }); }
    catch { return held('release_search_unavailable'); }
    if (result?.state !== 'candidates' || !Array.isArray(result.items) ||
        result.items.length > 50 || result.items.some((item) =>
          typeof item?.guid !== 'string' || !item.guid ||
          typeof item.title !== 'string' || !item.title || item.evidence !== 'unverified')) {
      return held('release_search_unavailable');
    }
    return { state: 'candidates', requestId, anidbId: request.anidbId,
      items: result.items, exhaustive: false };
  };
}
