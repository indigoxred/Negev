import { DatabaseSync } from 'node:sqlite';

const REASON = 'awaiting_availability_evidence';

function canonicalIntent(intent) {
  if (intent?.state !== 'ready' || !Number.isSafeInteger(intent.anidbId) || intent.anidbId <= 0 ||
      !['series', 'movie'].includes(intent.kind) || typeof intent.monitorFuture !== 'boolean' ||
      (intent.kind === 'movie' && intent.monitorFuture) ||
      !Array.isArray(intent.episodeIds) || intent.episodeIds.length === 0 ||
      intent.episodeIds.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
      new Set(intent.episodeIds).size !== intent.episodeIds.length) {
    throw new TypeError('Invalid exact request intent');
  }
  const episodeIds = [...intent.episodeIds].sort((a, b) => a - b);
  return { anidbId: intent.anidbId, kind: intent.kind,
    monitorFuture: intent.monitorFuture, episodeIds, episodeKey: episodeIds.join(',') };
}

// Request history and acquisition targets are distinct. This ledger never
// dispatches a torrent, deletes a request or asserts that media is available.
export function openRequestLedger(dbPath) {
  if (typeof dbPath !== 'string' || !dbPath || dbPath === ':memory:') {
    throw new TypeError('A durable request database path is required');
  }
  const db = new DatabaseSync(dbPath, { timeout: 5_000 });
  try {
    db.exec('PRAGMA journal_mode=WAL');
    db.exec(`CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY,
      requester_id INTEGER NOT NULL CHECK(requester_id > 0),
      request_key TEXT NOT NULL,
      anidb_id INTEGER NOT NULL CHECK(anidb_id > 0),
      kind TEXT NOT NULL CHECK(kind IN ('series','movie')),
      episode_key TEXT NOT NULL,
      monitor_future INTEGER NOT NULL CHECK(monitor_future IN (0,1)),
      created_ms INTEGER NOT NULL CHECK(created_ms >= 0),
      status TEXT NOT NULL CHECK(status = 'held'),
      reason TEXT NOT NULL,
      UNIQUE(requester_id,request_key)
    ) STRICT`);
    db.exec(`CREATE TABLE IF NOT EXISTS targets (
      id INTEGER PRIMARY KEY,
      anidb_id INTEGER NOT NULL CHECK(anidb_id > 0),
      episode_id INTEGER NOT NULL CHECK(episode_id > 0),
      status TEXT NOT NULL CHECK(status = 'held'),
      reason TEXT NOT NULL,
      UNIQUE(anidb_id,episode_id)
    ) STRICT`);
    db.exec(`CREATE TABLE IF NOT EXISTS request_targets (
      request_id INTEGER NOT NULL REFERENCES requests(id),
      target_id INTEGER NOT NULL REFERENCES targets(id),
      PRIMARY KEY(request_id,target_id)
    ) STRICT`);
    db.exec('PRAGMA foreign_keys=ON');
  } catch (error) { db.close(); throw error; }

  const findRequest = db.prepare(`SELECT id,anidb_id,kind,episode_key,monitor_future
    FROM requests WHERE requester_id=? AND request_key=?`);
  const insertRequest = db.prepare(`INSERT INTO requests
    (requester_id,request_key,anidb_id,kind,episode_key,monitor_future,created_ms,status,reason)
    VALUES (?,?,?,?,?,?,?,'held',?)`);
  const insertTarget = db.prepare(`INSERT INTO targets(anidb_id,episode_id,status,reason)
    VALUES (?,?,'held',?) ON CONFLICT(anidb_id,episode_id) DO NOTHING`);
  const findTarget = db.prepare('SELECT id FROM targets WHERE anidb_id=? AND episode_id=?');
  const insertLink = db.prepare('INSERT INTO request_targets(request_id,target_id) VALUES (?,?)');
  const findLinks = db.prepare(`SELECT t.id,t.episode_id FROM targets t
    JOIN request_targets rt ON rt.target_id=t.id WHERE rt.request_id=? ORDER BY t.episode_id`);
  const get = db.prepare(`SELECT id,requester_id,anidb_id,kind,monitor_future,created_ms,status,reason
    FROM requests WHERE id=?`);
  const countRequests = db.prepare('SELECT COUNT(*) AS count FROM requests');
  const countTargets = db.prepare('SELECT COUNT(*) AS count FROM targets');

  function transact(action) {
    let begun = false;
    try {
      db.exec('BEGIN IMMEDIATE');
      begun = true;
      const result = action();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      if (begun) db.exec('ROLLBACK');
      throw error;
    }
  }

  return {
    submit({ requesterId, requestKey, intent, nowMs }) {
      if (!Number.isSafeInteger(requesterId) || requesterId <= 0 ||
          typeof requestKey !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(requestKey) ||
          !Number.isSafeInteger(nowMs) || nowMs < 0) throw new TypeError('Invalid requester or time');
      const item = canonicalIntent(intent);
      return transact(() => {
        const existing = findRequest.get(requesterId, requestKey);
        if (existing) {
          if (existing.anidb_id !== item.anidbId || existing.kind !== item.kind ||
              existing.episode_key !== item.episodeKey ||
              existing.monitor_future !== Number(item.monitorFuture)) {
            return { state: 'held', reason: 'idempotency_key_conflict' };
          }
          return { state: 'held', reason: REASON, requestId: existing.id,
            targetIds: findLinks.all(existing.id).map((row) => row.id), created: false };
        }
        const requestId = Number(insertRequest.run(requesterId, requestKey, item.anidbId,
          item.kind, item.episodeKey, Number(item.monitorFuture), nowMs, REASON).lastInsertRowid);
        const targetIds = [];
        for (const episodeId of item.episodeIds) {
          insertTarget.run(item.anidbId, episodeId, REASON);
          const targetId = findTarget.get(item.anidbId, episodeId).id;
          insertLink.run(requestId, targetId);
          targetIds.push(targetId);
        }
        return { state: 'held', reason: REASON, requestId, targetIds, created: true };
      });
    },
    getRequest(requestId) {
      if (!Number.isSafeInteger(requestId) || requestId <= 0) throw new TypeError('Invalid request ID');
      const row = get.get(requestId);
      return row ? { id: row.id, requesterId: row.requester_id, anidbId: row.anidb_id,
        kind: row.kind, monitorFuture: Boolean(row.monitor_future),
        episodeIds: findLinks.all(row.id).map((link) => link.episode_id),
        status: row.status, reason: row.reason, createdMs: row.created_ms } : null;
    },
    countRequests() { return countRequests.get().count; },
    countTargets() { return countTargets.get().count; },
    close() { db.close(); },
  };
}
