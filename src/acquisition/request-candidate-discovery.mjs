import { collectAniDbDetail } from '../catalogue/collect-detail.mjs';
import { trustedReleaseQueries } from './trusted-release-queries.mjs';

const held = (reason) => ({ state: 'held', reason });

// This joins a saved exact request to a current Shoko title before searching.
// Neither a title nor a Prowlarr hit proves the release's AniDB file identity.
export function createRequestCandidateDiscovery({ readRequest, loadDetail,
  searchReleases, releaseQueries = async () => [],
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  if (typeof readRequest !== 'function' || typeof loadDetail !== 'function' ||
      typeof searchReleases !== 'function' || typeof releaseQueries !== 'function' ||
      typeof pause !== 'function') {
    throw new TypeError('Invalid request discovery configuration');
  }
  return async ({ requestId, searchTargetEpisodeId = null }) => {
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
    if (typeof detail.restricted !== 'boolean') return held('restricted_or_unverified');
    const episodeIds = new Set(detail.episodes.map((episode) => episode.id));
    if (request.episodeIds.some((id) => !episodeIds.has(id))) return held('target_missing');
    let target = null;
    if (searchTargetEpisodeId !== null) {
      target = detail.episodes.find((episode) => episode.id === searchTargetEpisodeId);
      if (request.kind !== 'series' ||
          !request.episodeIds.includes(searchTargetEpisodeId) ||
          target?.type !== 'Episode' ||
          !Number.isSafeInteger(target.number) || target.number < 1) {
        return held('invalid_request');
      }
    }
    let aliases;
    try { aliases = await releaseQueries({ anidbId: request.anidbId }); }
    catch { aliases = []; }
    const titleQueries = trustedReleaseQueries(detail.title, aliases);
    const targeted = target && titleQueries.length > 0 ?
      `${titleQueries[0]} ${String(target.number).padStart(2, '0')}` : null;
    const queries = targeted && targeted.length <= 120 ?
      [targeted, ...titleQueries] : titleQueries;
    if (queries.length === 0) return held('query_too_long');
    const buckets = [];
    let successful = 0;
    for (const [index, query] of queries.entries()) {
      if (index > 0) await pause(1_000);
      let result;
      try { result = await searchReleases({ query }); }
      catch { continue; }
      if (result?.state !== 'candidates' || !Array.isArray(result.items) ||
          result.items.length > 50 || result.items.some((item) =>
            typeof item?.guid !== 'string' || !item.guid ||
            typeof item.title !== 'string' || !item.title || item.evidence !== 'unverified')) {
        continue;
      }
      successful++;
      buckets.push(result.items);
    }
    if (successful === 0) return held('release_search_unavailable');
    const items = [];
    const seenCandidates = new Set();
    // Each source gets a chance before the 50-item cap. An older exact
    // episode hit must not displace every same-title alias result.
    for (let position = 0; position < 50 && items.length < 50; position++) {
      let any = false;
      for (const bucket of buckets) {
        const item = bucket[position];
        if (!item) continue;
        any = true;
        const key = `${item.indexerId}:${item.guid}`;
        if (seenCandidates.has(key)) continue;
        seenCandidates.add(key);
        items.push(item);
        if (items.length === 50) break;
      }
      if (!any) break;
    }
    return { state: 'candidates', requestId, anidbId: request.anidbId,
      items, exhaustive: false };
  };
}
