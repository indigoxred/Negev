import { cancelResponseBody, readBoundedJson } from '../http/bounded-response.mjs';

// Metadata absence is not an unknown hash or a failed download.
export async function readShokoEpisodeMetadata({ baseUrl, apiKey, anidbId,
  episodeId, fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  let base;
  try { base = new URL(baseUrl); } catch { throw new TypeError('Invalid metadata URL'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username ||
      base.password || base.pathname !== '/' || base.search || base.hash ||
      typeof apiKey !== 'string' || !apiKey ||
      ![anidbId,episodeId].every(id => Number.isSafeInteger(id) && id > 0) ||
      typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 || timeoutMs > 60_000) throw new TypeError('Invalid episode metadata lookup');
  try {
    const response = await fetchImpl(new URL('/api/v3/Episode/AniDB/' + episodeId,base),
      {method:'GET',redirect:'manual',headers:{Authorization:'Bearer ' + apiKey,
        Accept:'application/json'},signal:AbortSignal.timeout(timeoutMs)});
    if (response.status !== 200) await cancelResponseBody(response);
    if (response.status === 404) return {state:'missing'};
    if (response.status !== 200) return {state:'unavailable'};
    const item = await readBoundedJson(response,100_000);
    return {state:item?.ID === episodeId && item.AnimeID === anidbId
      ? 'present' : 'unavailable'};
  } catch { return {state:'unavailable'}; }
}
