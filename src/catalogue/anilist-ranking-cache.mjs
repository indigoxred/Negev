import { DatabaseSync } from 'node:sqlite';
import { readBoundedJson } from '../http/bounded-response.mjs';

const REFRESH_MS = 12 * 60 * 60_000;
const STALE_MS = 7 * 24 * 60 * 60_000;
const RETRY_MS = 15 * 60_000;
const scopes = new Set(['all', 'ongoing']);
const validId = (value) => Number.isSafeInteger(value) && value > 0 &&
  value <= 2_147_483_647;

function query(scope) {
  const status = scope === 'ongoing' ? ',status:RELEASING' : '';
  const pages = [['s', 'SCORE_DESC'], ['p', 'POPULARITY_DESC']]
    .flatMap(([prefix, sort]) => [1, 2, 3].map((page) =>
      `${prefix}${page}:Page(page:${page},perPage:50){media(type:ANIME,sort:${sort}${status}){idMal averageScore popularity}}`));
  return `query { ${pages.join(' ')} }`;
}

function decode(data) {
  if (!data || typeof data !== 'object' || data.errors || !data.data) {
    throw new TypeError('Invalid AniList ranking');
  }
  const ranked = (prefix) => {
    const result = [];
    const seen = new Set();
    for (let page = 1; page <= 3; page++) {
      const rows = data.data[`${prefix}${page}`]?.media;
      if (!Array.isArray(rows) || rows.length > 50 ||
          page === 1 && rows.length < 1) throw new TypeError('Invalid AniList page');
      for (let offset = 0; offset < rows.length; offset++) {
        const item = rows[offset];
        if (!item || item.idMal !== null && !validId(item.idMal) ||
            item.averageScore !== null &&
              (!Number.isSafeInteger(item.averageScore) ||
                item.averageScore < 0 || item.averageScore > 100) ||
            !Number.isSafeInteger(item.popularity) ||
              item.popularity < 0 || item.popularity > 1_000_000_000) {
          throw new TypeError('Invalid AniList item');
        }
        if (item.idMal === null) continue;
        // AniList can repeat an exact MAL ID in its ranked pages. Keep its
        // first (higher) position; never infer a replacement by title.
        if (seen.has(item.idMal)) continue;
        seen.add(item.idMal);
        result.push({ malId: item.idMal, rank: (page - 1) * 50 + offset + 1,
          score: item.averageScore === null ? null : item.averageScore / 10,
          members: item.popularity });
      }
    }
    return result;
  };
  return { score: ranked('s'), popular: ranked('p') };
}

// Scores affect presentation only. AniDB and Shoko remain the identity and
// file-proof sources; no title-string join is allowed here.
export function openAniListRankingCache({ dbPath, fetchImpl = fetch,
  now = Date.now, timeoutMs = 6_000 } = {}) {
  if (typeof dbPath !== 'string' || !dbPath ||
      typeof fetchImpl !== 'function' || typeof now !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) {
    throw new TypeError('Invalid AniList ranking cache');
  }
  const db = new DatabaseSync(dbPath, { timeout: 5_000 });
  db.exec('PRAGMA journal_mode=WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS catalogue_anilist_rankings (
    scope TEXT PRIMARY KEY CHECK(scope IN ('all','ongoing')),
    checked_ms INTEGER NOT NULL CHECK(checked_ms>=0),
    payload TEXT NOT NULL
  ) STRICT`);
  const select = db.prepare('SELECT checked_ms,payload FROM catalogue_anilist_rankings WHERE scope=?');
  const save = db.prepare(`INSERT INTO catalogue_anilist_rankings
    (scope,checked_ms,payload) VALUES (?,?,?) ON CONFLICT(scope) DO UPDATE SET
    checked_ms=excluded.checked_ms,payload=excluded.payload`);
  const cached = new Map();
  const inflight = new Map();
  const lastAttempt = new Map();
  let closed = false;
  const snapshot = (scope) => {
    if (cached.has(scope)) return cached.get(scope);
    const row = select.get(scope);
    let saved = null;
    if (row && row.payload.length <= 100_000) {
      try {
        const data = JSON.parse(row.payload);
        const checkedMs = row.checked_ms;
        if (Number.isSafeInteger(checkedMs) && checkedMs >= 0 &&
            Array.isArray(data.score) && Array.isArray(data.popular) &&
            data.score.length <= 150 && data.popular.length <= 150 &&
            data.score.every((item) => validId(item.malId) &&
              Number.isSafeInteger(item.rank) && item.rank > 0 && item.rank <= 150 &&
              (item.score === null || typeof item.score === 'number' &&
                Number.isFinite(item.score) && item.score >= 0 && item.score <= 10) &&
              Number.isSafeInteger(item.members) && item.members >= 0) &&
            data.popular.every((item) => validId(item.malId) &&
              Number.isSafeInteger(item.rank) && item.rank > 0 && item.rank <= 150 &&
              (item.score === null || typeof item.score === 'number' &&
                Number.isFinite(item.score) && item.score >= 0 && item.score <= 10) &&
              Number.isSafeInteger(item.members) && item.members >= 0)) {
          saved = { ...data, checkedMs };
        }
      } catch { /* A bad optional snapshot is ignored. */ }
    }
    cached.set(scope, saved);
    return saved;
  };
  const refresh = (scope) => {
    if (inflight.has(scope)) return inflight.get(scope);
    const promise = (async () => {
      lastAttempt.set(scope, now());
      try {
        const response = await fetchImpl('https://graphql.anilist.co', {
          method: 'POST', redirect: 'manual',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ query: query(scope) }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.status !== 200) throw new Error('AniList unavailable');
        const value = decode(await readBoundedJson(response, 100_000));
        const checkedMs = now();
        if (closed || !Number.isSafeInteger(checkedMs) || checkedMs < 0) return;
        save.run(scope, checkedMs, JSON.stringify(value));
        cached.set(scope, { ...value, checkedMs });
      } catch { /* Keep the last good ranking through source outages. */ }
    })().finally(() => inflight.delete(scope));
    inflight.set(scope, promise);
    return promise;
  };
  return {
    async read(scope) {
      if (!scopes.has(scope) || closed) throw new TypeError('Invalid ranking scope');
      let value = snapshot(scope);
      const time = now();
      if (value && value.checkedMs <= time &&
          value.checkedMs + REFRESH_MS > time) {
        return { state: 'ready', ...value };
      }
      const recent = lastAttempt.get(scope);
      if (recent === undefined || recent > time || recent + RETRY_MS <= time) {
        if (value) void refresh(scope);
        else await refresh(scope);
      }
      value = snapshot(scope);
      return value && value.checkedMs <= time &&
        value.checkedMs + STALE_MS > time
        ? { state: value.checkedMs + REFRESH_MS > time ? 'ready' : 'stale', ...value }
        : { state: 'unavailable' };
    },
    async whenIdle() { await Promise.all([...inflight.values()]); },
    close() { closed = true; cached.clear(); db.close(); },
  };
}
