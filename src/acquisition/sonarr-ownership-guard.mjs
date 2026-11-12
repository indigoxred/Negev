import { createHash } from 'node:crypto';
import { readBoundedText } from '../http/bounded-response.mjs';
import { mapSonarrOwnership } from './sonarr-ownership-map.mjs';

const MAP_URL = 'https://github.com/cplieger/animap/releases/latest/download/animap.json';
const CHECKSUM_URL = `${MAP_URL}.sha256`;
const MAX_MAP_BYTES = 30_000_000;
const MAX_SONARR_BYTES = 5_000_000;
const MAP_CACHE_MS = 24 * 60 * 60_000;
const MAX_MAP_AGE_MS = 14 * 24 * 60 * 60_000;
const OWNERSHIP_FRESH_MS = 2 * 60_000;
const validId = (value) => Number.isSafeInteger(value) && value > 0;
const held = (reason) => ({ state: 'held', reason });

// A temporary, fail-closed cutover guard. No requests or torrent starts may
// use a stale Sonarr observation. The map is a versioned public release; the
// Sonarr API key stays in memory and is sent only to the configured LAN host.
export function createSonarrOwnershipGuard({ sonarrBaseUrl, sonarrApiKey,
  fetchImpl = fetch, now = Date.now } = {}) {
  let base;
  try { base = new URL(sonarrBaseUrl); } catch { /* Rejected below. */ }
  if (!base || base.protocol !== 'http:' || base.username || base.password ||
      base.pathname !== '/' || base.search || base.hash ||
      sonarrBaseUrl !== base.origin ||
      typeof sonarrApiKey !== 'string' || !/^[a-zA-Z0-9]{16,128}$/.test(sonarrApiKey) ||
      typeof fetchImpl !== 'function' || typeof now !== 'function') {
    throw new TypeError('Invalid Sonarr ownership guard');
  }
  let cachedMap = null;
  let mapCheckedMs = null;
  let observation = null;
  let pending = null;
  const readMap = async (time) => {
    if (cachedMap && mapCheckedMs + MAP_CACHE_MS > time) return cachedMap;
    const [mapResponse, digestResponse] = await Promise.all([
      fetchImpl(MAP_URL, { signal: AbortSignal.timeout(20_000),
        headers: { Accept: 'application/json' } }),
      fetchImpl(CHECKSUM_URL, { signal: AbortSignal.timeout(10_000),
        headers: { Accept: 'text/plain' } }),
    ]);
    if (mapResponse.status !== 200 || digestResponse.status !== 200) {
      throw new Error('Ownership map unavailable');
    }
    const [raw, checksum] = await Promise.all([
      readBoundedText(mapResponse, MAX_MAP_BYTES),
      readBoundedText(digestResponse, 256),
    ]);
    const expected = /^([0-9a-f]{64})\s+\*?animap\.json\s*$/i.exec(checksum)?.[1];
    if (!expected || createHash('sha256').update(raw).digest('hex') !==
        expected.toLowerCase()) throw new Error('Ownership map checksum mismatch');
    const map = JSON.parse(raw);
    const generatedMs = Date.parse(map?.generated_at);
    if (map?.version !== 2 || !Number.isSafeInteger(generatedMs) ||
        generatedMs > time + 24 * 60 * 60_000 ||
        generatedMs + MAX_MAP_AGE_MS < time) {
      throw new Error('Ownership map stale or unsupported');
    }
    cachedMap = map;
    mapCheckedMs = time;
    return map;
  };
  const refresh = ({ force = true } = {}) => {
    if (pending) return pending;
    if (!force && observation &&
        observation.checkedMs + 30_000 > now()) {
      return Promise.resolve({ state: 'ready',
        monitoredSeries: observation.monitoredSeries,
        blockedTitles: observation.ownedAnidbIds.size });
    }
    pending = (async () => {
      observation = null;
      const time = now();
      if (!Number.isSafeInteger(time) || time < 0) {
        return held('sonarr_ownership_unavailable');
      }
      let map;
      try { map = await readMap(time); }
      catch { return held('ownership_map_unavailable'); }
      let series;
      try {
        const response = await fetchImpl(`${base.origin}/api/v3/series`, {
          signal: AbortSignal.timeout(8_000),
          headers: { 'X-Api-Key': sonarrApiKey,
            Accept: 'application/json' },
        });
        if (response.status !== 200) throw new Error('Sonarr unavailable');
        series = JSON.parse(await readBoundedText(response, MAX_SONARR_BYTES));
      } catch { return held('sonarr_ownership_unavailable'); }
      const mapped = mapSonarrOwnership(map, series);
      if (mapped.state !== 'ready') return mapped;
      observation = { ...mapped, checkedMs: time };
      return { state: 'ready', monitoredSeries: mapped.monitoredSeries,
        blockedTitles: mapped.ownedAnidbIds.size };
    })().finally(() => { pending = null; });
    return pending;
  };
  return {
    refresh,
    status(anidbId) {
      if (!validId(anidbId) || !observation ||
          observation.checkedMs + OWNERSHIP_FRESH_MS <= now()) {
        return 'unavailable';
      }
      if (!observation.knownAnidbIds.has(anidbId)) return 'unmapped';
      return observation.ownedAnidbIds.has(anidbId) ? 'owned' : 'eligible';
    },
  };
}
