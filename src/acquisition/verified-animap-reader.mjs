import { createHash } from 'node:crypto';
import { readBoundedText } from '../http/bounded-response.mjs';

const MAP_URL = 'https://github.com/cplieger/animap/releases/latest/download/animap.json';
const CHECKSUM_URL = `${MAP_URL}.sha256`;
const MAP_CACHE_MS = 24 * 60 * 60_000;
const MAX_MAP_AGE_MS = 14 * 24 * 60 * 60_000;

// Shared, bounded source for both the temporary Sonarr guard and future
// parent-watch reconciliation. No caller may use an unchecked local map.
export function createVerifiedAniMapReader({ fetchImpl = fetch, now = Date.now } = {}) {
  if (typeof fetchImpl !== 'function' || typeof now !== 'function') {
    throw new TypeError('Invalid AniMap reader');
  }
  let cached = null;
  let checkedMs = null;
  let pending = null;
  async function fetchMap(time) {
    const [mapResponse, digestResponse] = await Promise.all([
      fetchImpl(MAP_URL, { signal: AbortSignal.timeout(20_000),
        headers: { Accept: 'application/json' } }),
      fetchImpl(CHECKSUM_URL, { signal: AbortSignal.timeout(10_000),
        headers: { Accept: 'text/plain' } }),
    ]);
    if (mapResponse.status !== 200 || digestResponse.status !== 200) {
      throw new Error('AniMap release unavailable');
    }
    const [raw, checksum] = await Promise.all([
      readBoundedText(mapResponse, 30_000_000),
      readBoundedText(digestResponse, 256),
    ]);
    const expected = /^([0-9a-f]{64})\s+\*?animap\.json\s*$/i.exec(checksum)?.[1];
    if (!expected || createHash('sha256').update(raw).digest('hex') !==
        expected.toLowerCase()) throw new Error('AniMap checksum mismatch');
    const map = JSON.parse(raw);
    const generatedMs = Date.parse(map?.generated_at);
    if (map?.version !== 2 || !Array.isArray(map.anime) ||
        map.anime.length < 1 || map.anime.length > 100_000 ||
        !Number.isSafeInteger(generatedMs) || generatedMs > time + 24 * 60 * 60_000 ||
        generatedMs + MAX_MAP_AGE_MS < time) {
      throw new Error('AniMap release stale or unsupported');
    }
    cached = map;
    checkedMs = time;
    return map;
  }
  return {
    read() {
      const time = now();
      if (!Number.isSafeInteger(time) || time < 0) {
        return Promise.reject(new TypeError('Invalid AniMap read time'));
      }
      if (cached && checkedMs + MAP_CACHE_MS > time) return Promise.resolve(cached);
      if (pending) return pending;
      pending = fetchMap(time).finally(() => { pending = null; });
      return pending;
    },
  };
}
