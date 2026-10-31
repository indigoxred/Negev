import { readBoundedText } from '../http/bounded-response.mjs';

// Deliberately separate from catalogue GETs. Calling this supported Shoko
// action changes its AniDB metadata cache and must be rate limited by the
// caller. A successful response is never proof of requestable episode detail.
export async function requestAniDbHydration({
  baseUrl, apiKey, anidbId, fetchImpl = fetch, timeoutMs = 10_000,
}) {
  if (!Number.isSafeInteger(anidbId) || anidbId <= 0 ||
      typeof apiKey !== 'string' || !apiKey ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError('Invalid AniDB hydration request');
  }
  let base;
  try { base = new URL(baseUrl); } catch { throw new TypeError('Invalid Shoko base URL'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new TypeError('Invalid Shoko base URL');
  }
  const url = new URL(`/api/v3/Series/AniDB/${anidbId}/Refresh`, base);
  for (const [key, value] of Object.entries({
    createSeriesEntry: 'false', downloadRelations: 'false', skipTmdbUpdate: 'true',
    force: 'false', immediate: 'false', cacheOnly: 'false',
  })) url.searchParams.set(key, value);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      redirect: 'manual',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status !== 200) return { state: 'unavailable' };
    const body = await readBoundedText(response, 16);
    if (body === 'false') return { state: 'queued' };
    if (body === 'true') return { state: 'refresh_accepted' };
  } catch { /* Transport or malformed response: never claim success. */ }
  return { state: 'unavailable' };
}
