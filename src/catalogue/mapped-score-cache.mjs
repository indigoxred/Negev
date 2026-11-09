import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { readBoundedJson } from '../http/bounded-response.mjs';

const validId = (value) => Number.isSafeInteger(value) && value > 0 &&
  value <= 2_147_483_647;
const WEEK = 7 * 24 * 60 * 60_000;
const MONTH = 30 * 24 * 60 * 60_000;

// Optional catalogue ranking data. Scores never authorize requests, downloads,
// file matches, imports, or Plex availability.
export function openMappedScoreCache({ dbPath, fetchImpl = fetch,
  now = Date.now, timeoutMs = 3_000, minGapMs = 250 } = {}) {
  if (typeof dbPath !== 'string' || !dbPath ||
      typeof fetchImpl !== 'function' || typeof now !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5_000 ||
      !Number.isSafeInteger(minGapMs) || minGapMs < 0 || minGapMs > 5_000) {
    throw new TypeError('Invalid mapped score cache');
  }
  const db = new DatabaseSync(dbPath, { timeout: 5_000 });
  db.exec('PRAGMA journal_mode=WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS catalogue_score_snapshots (
    anidb_id INTEGER PRIMARY KEY CHECK(anidb_id>0),
    mal_id INTEGER NOT NULL CHECK(mal_id>0),
    state TEXT NOT NULL CHECK(state IN ('rated','unrated','unavailable')),
    score REAL CHECK(score IS NULL OR score>=0 AND score<=10),
    votes INTEGER CHECK(votes IS NULL OR votes>=0),
    members INTEGER CHECK(members IS NULL OR members>=0),
    checked_ms INTEGER NOT NULL CHECK(checked_ms>=0)
  ) STRICT`);
  const find = db.prepare(`SELECT mal_id,state,score,votes,members,checked_ms
    FROM catalogue_score_snapshots WHERE anidb_id=?`);
  const save = db.prepare(`INSERT INTO catalogue_score_snapshots
    (anidb_id,mal_id,state,score,votes,members,checked_ms)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(anidb_id) DO UPDATE SET
    mal_id=excluded.mal_id,state=excluded.state,score=excluded.score,
    votes=excluded.votes,members=excluded.members,checked_ms=excluded.checked_ms`);
  const pending = new Map();
  let draining = null;
  let closed = false;
  const validRow = (row, malId, time) => row?.mal_id === malId &&
    row.checked_ms <= time && row.checked_ms + MONTH > time;
  const observation = (row) => ({ state: row.state,
    score: row.score, votes: row.votes, members: row.members });
  const readScore = async (malId) => {
    try {
      const response = await fetchImpl(`https://animap.id/api/mal/${malId}/raw`, {
        method: 'GET', redirect: 'manual',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status !== 200) throw new Error('Score source unavailable');
      const data = await readBoundedJson(response, 128_000);
      if (data?.mal_id !== malId) throw new Error('Score identity changed');
      const votes = data.scored_by;
      const members = data.members;
      if (!Number.isSafeInteger(votes) || votes < 0 || votes > 1_000_000_000 ||
          !Number.isSafeInteger(members) || members < 0 ||
          members > 1_000_000_000) throw new Error('Invalid score counters');
      const score = data.score;
      if (score === null || score === undefined) return {
        state: 'unrated', score: null, votes, members };
      if (typeof score !== 'number' || !Number.isFinite(score) ||
          score < 0 || score > 10 || votes === 0) {
        throw new Error('Invalid score');
      }
      return { state: 'rated', score, votes, members };
    } catch {
      return { state: 'unavailable', score: null, votes: null,
        members: null };
    }
  };
  const drain = () => {
    if (draining || closed) return;
    draining = (async () => {
      while (pending.size && !closed) {
        const [anidbId, malId] = pending.entries().next().value;
        pending.delete(anidbId);
        const value = await readScore(malId);
        if (closed) break;
        save.run(anidbId, malId, value.state, value.score,
          value.votes, value.members, now());
        if (pending.size && minGapMs) await sleep(minGapMs);
      }
    })().finally(() => { draining = null; if (pending.size && !closed) drain(); });
  };
  return {
    get(anidbId, malId) {
      if (!validId(anidbId) || !validId(malId) || closed) return null;
      const row = find.get(anidbId);
      return validRow(row, malId, now()) ? observation(row) : null;
    },
    prime(entries) {
      if (closed || !Array.isArray(entries) || entries.length > 10_000 ||
          entries.some((entry) => !validId(entry?.anidbId) ||
            !validId(entry?.malId))) throw new TypeError('Invalid score entries');
      const time = now();
      let checked = 0;
      for (const { anidbId, malId } of entries) {
        const row = find.get(anidbId);
        if (validRow(row, malId, time)) checked++;
        const lifetime = row?.state === 'unavailable' ? 60 * 60_000 : WEEK;
        if (row?.mal_id !== malId || row.checked_ms > time ||
            row.checked_ms + lifetime <= time) pending.set(anidbId, malId);
      }
      drain();
      return { ready: checked === entries.length,
        checked, total: entries.length };
    },
    whenIdle: async () => { while (draining) await draining; },
    close() { closed = true; pending.clear(); db.close(); },
  };
}
