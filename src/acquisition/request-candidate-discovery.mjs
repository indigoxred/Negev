import { collectAniDbDetail } from '../catalogue/collect-detail.mjs';
import { inferReleaseState } from '../catalogue/infer-release-state.mjs';
import { trustedReleaseQueries, trustedTargetedQueries } from './trusted-release-queries.mjs';
import { hasTargetEpisodeHint } from './release-preference.mjs';
import { matchesReleaseFilters, validReleaseFilters } from '../web/public/release-choice-fields.mjs';

const held = (reason) => ({ state: 'held', reason });

// This joins a saved exact request to a current Shoko title before searching.
// Neither a title nor a Prowlarr hit proves the release's AniDB file identity.
export function createRequestCandidateDiscovery({ readRequest, loadDetail,
  searchReleases, releaseQueries = async () => [],
  now = Date.now,
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  if (typeof readRequest !== 'function' || typeof loadDetail !== 'function' ||
      typeof searchReleases !== 'function' || typeof releaseQueries !== 'function' ||
      typeof pause !== 'function' || typeof now !== 'function') {
    throw new TypeError('Invalid request discovery configuration');
  }
  const queryCache = new Map();
  const discover = async ({ requestId, searchTargetEpisodeId = null,
    searchTargetEpisodeIds = null, interactive = false, query = null, resultOffset = 0, filters = null }) => {
    if (filters !== null && (!interactive || !validReleaseFilters(filters))) return held('invalid_release_filters');
    if(!Number.isSafeInteger(resultOffset)||resultOffset<0||resultOffset>150||(!interactive&&resultOffset!==0))return held('invalid_request');
    if (typeof interactive !== 'boolean' || (query !== null && (!interactive ||
        typeof query !== 'string' || query.trim().length<2 || query.length>120 ||
        /[\x00-\x1f\x7f]/.test(query)))) return held('invalid_request');
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
    if (searchTargetEpisodeIds !== null &&
        (!Array.isArray(searchTargetEpisodeIds) ||
          searchTargetEpisodeIds.length < 1 || searchTargetEpisodeIds.length > 10 ||
          new Set(searchTargetEpisodeIds).size !== searchTargetEpisodeIds.length)) {
      return held('invalid_request');
    }
    const releaseState = inferReleaseState({
      today: new Date(now()).toISOString().slice(0, 10), ...detail,
    }).state;
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
    const targets = releaseState !== 'completed' && searchTargetEpisodeIds
      ? searchTargetEpisodeIds.map((id) => detail.episodes.find((episode) =>
        episode.id === id)) : target ? [target] : [];
    if (targets.some((episode) => request.kind !== 'series' ||
        !episode || !request.episodeIds.includes(episode.id) ||
        episode.type !== 'Episode' ||
        !Number.isSafeInteger(episode.number) || episode.number < 1)) {
      return held('invalid_request');
    }
    const targetByQuery = new Map();
    for (const episode of targets) {
      for (const query of trustedTargetedQueries(detail.title, aliases,
        episode.number)) targetByQuery.set(query, episode);
    }
    const targeted = [...targetByQuery.keys()];
    // One canonical query per missing episode first, then broad aliases and
    // remaining targeted aliases. Never multiply ten episodes by every alias.
    const canonicalTargets = targets.map(episode =>
      trustedTargetedQueries(detail.title, aliases, episode.number)[0]).filter(Boolean);
    const primaryAliases = target ? targeted.filter(query =>
      targetByQuery.get(query)?.id === target.id) : [];
    const originalQueries = [...targeted, ...titleQueries];
    let queries = originalQueries.length <= 16 ? originalQueries :
      [...new Set([...canonicalTargets, ...titleQueries,
        ...primaryAliases, ...targeted])].slice(0, 16);
    const interactiveTruncated=interactive&&!query&&queries.length>4;
    if(interactive) {
      if(query) {
        const phrase=query.trim();
        // Same-ID names are retrieval hints only. Keep the user's extra terms
        // (group, quality, etc.) while trying official alternate spellings.
        const year=/\s+\(((?:19|20)\d{2})\)$/.exec(detail.title)?.[1];
        const names=[...new Set(titleQueries.map(name=>name.replace(/\s+\((?:19|20)\d{2}\)$/,'')))];
        const escape=value=>value.replace(/[.*+?^{}$()|[\]\\]/g,'\\$&');
        let matched=null;
        for(const name of [...names].sort((a,b)=>b.length-a.length)) {
          const pattern=new RegExp('(^|\\s)'+escape(name)+'(?=\\s|$)','iu');
          if(pattern.test(phrase)){matched={pattern};break;}
        }
        queries=[phrase];
        if(matched) for(const name of names) {
          let alternative=phrase.replace(matched.pattern,(_,space)=>space+name);
          if(year) alternative=alternative.replace(new RegExp('\\s+\\(?'+year+'\\)?(?=\\s|$)'),'');
          if(alternative.length>=2&&alternative.length<=120&&!queries.some(q=>q.toLocaleLowerCase('en')===alternative.toLocaleLowerCase('en')))queries.push(alternative);
          if(queries.length===4)break;
        }
      } else queries=queries.slice(0,4);
    }
    if (queries.length === 0) return held('query_too_long');
    const buckets = [];
    let successful = 0;
    const failedQueries = [];
    for (const [index, query] of queries.entries()) {
      let result;
      const queryTarget = targetByQuery.get(query);
      const cacheKey = JSON.stringify([query, queryTarget?.number ?? null,interactive?200:25]);
      const saved = queryCache.get(cacheKey);
      try {
        if (saved && saved.until > now()) result = saved.result;
        else {
          if (index > 0) await pause(1_000);
          result = await searchReleases({ query,
            ...(interactive?{limit:200}:{}),
            targetEpisodeNumber: queryTarget?.number ?? null });
        }
      }
      catch { failedQueries.push(query); continue; }
      if (result?.state !== 'candidates' || !Array.isArray(result.items) ||
          result.items.length > (interactive?200:50) || result.items.some((item) =>
            typeof item?.guid !== 'string' || !item.guid ||
            typeof item.title !== 'string' || !item.title || item.evidence !== 'unverified')) {
        failedQueries.push(query);
        continue;
      }
      successful++;
      queryCache.set(cacheKey, { result, anidbId: request.anidbId,
        until: saved?.result === result ? saved.until :
          now() + (result.items.length ? 300_000 : 20_000) });
      while (queryCache.size > 64) queryCache.delete(queryCache.keys().next().value);
      // Preserve which bucket answered the exact missing-episode query. This
      // is ordering evidence only; stopped metainfo and identity checks still
      // decide whether a candidate can be submitted.
      buckets.push(result.items.filter(item=>filters===null||matchesReleaseFilters(item,filters)).map((item) => ({ ...item,
        ...(!interactive ? {sourceQuery: query} : {}),
        ...(targets.some((episode) => hasTargetEpisodeHint(item, episode.number)) ?
          { targetedEpisode: true } : {}),
        ...(queryTarget ? {
          ...(!hasTargetEpisodeHint(item, queryTarget.number) ?
            { targetedEpisode: false } : {}),
          targetEpisodeId: queryTarget.id } : {}) })));
    }
    if (successful === 0) return held('release_search_unavailable');
    // Aggregate before applying the cap: a later bucket can correct evidence
    // even when its copy would fall outside the first 50 visible releases.
    const bestByCandidate = new Map();
    const evidenceRank = (item) => item.targetedEpisode === true
      ? item.targetEpisodeId !== undefined ? 3 : 2
      : item.targetedEpisode === false ? 0 : 1;
    for (const bucket of buckets) for (const item of bucket) {
      const key = `${item.indexerId}:${item.guid}`;
      const prior = bestByCandidate.get(key);
      if (!prior || evidenceRank(item) > evidenceRank(prior)) {
        bestByCandidate.set(key, item);
      }
    }
    const items = [];
    const seenCandidates = new Set();
    // Each source gets a chance before the 50-item cap. An older exact
    // episode hit must not displace every same-title alias result.
    const combinedLimit=interactive?200:50;
    for (let position = 0; position < combinedLimit && items.length < combinedLimit; position++) {
      let any = false;
      for (const bucket of buckets) {
        const item = bucket[position];
        if (!item) continue;
        any = true;
        const key = `${item.indexerId}:${item.guid}`;
        if (seenCandidates.has(key)) continue;
        seenCandidates.add(key);
        items.push(bestByCandidate.get(key));
        if (items.length === combinedLimit) break;
      }
      if (!any) break;
    }
    if (items.length === 0 && failedQueries.length > 0) {
      return held('release_search_incomplete');
    }
    return { state: 'candidates', requestId, anidbId: request.anidbId,
      ...(interactiveTruncated?{searchIncomplete:true}:{}),
      items:items.slice(resultOffset,resultOffset+50), exhaustive: false,
      ...(interactive?{nextOffset:items.length>resultOffset+50&&resultOffset<150?resultOffset+50:null}:{}),
      ...(failedQueries.length > 0 ? {
        searchIncomplete: true, failedQueries } : {}),
      ...(releaseState === 'unknown' ? {} : { releaseState }) };
  };
  discover.invalidateTitle = (anidbId) => {
    for (const [key, value] of queryCache) {
      if (value.anidbId === anidbId) queryCache.delete(key);
    }
  };
  return discover;
}
