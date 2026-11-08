import { DatabaseSync } from 'node:sqlite';
import { isCompleteAniDbDetail } from '../catalogue/hydration-ledger.mjs';
import { hasStatedRegularEpisodes } from '../catalogue/stated-episode-count.mjs';

const REASON = 'awaiting_availability_evidence';
const held = (reason) => ({ state: 'held', reason });
function validFullDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function canonicalIntent(intent) {
  if (intent?.state !== 'ready' || !Number.isSafeInteger(intent.anidbId) || intent.anidbId <= 0 ||
      !['series', 'movie'].includes(intent.kind) || typeof intent.monitorFuture !== 'boolean' ||
      (intent.kind === 'movie' && intent.monitorFuture) ||
      !Array.isArray(intent.episodeIds) ||
      (intent.episodeIds.length === 0 &&
        !(intent.kind === 'series' && intent.monitorFuture)) ||
      intent.episodeIds.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
      new Set(intent.episodeIds).size !== intent.episodeIds.length ||
      (intent.title !== undefined &&
        (typeof intent.title !== 'string' || intent.title.length > 300 ||
          intent.title.trim() !== intent.title || !intent.title ||
          /[\x00-\x1f\x7f]/.test(intent.title)))) {
    throw new TypeError('Invalid exact request intent');
  }
  const episodeIds = [...intent.episodeIds].sort((a, b) => a - b);
  return { anidbId: intent.anidbId, kind: intent.kind, title: intent.title ?? null,
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
      command_key TEXT,
      title TEXT,
      anidb_id INTEGER NOT NULL CHECK(anidb_id > 0),
      kind TEXT NOT NULL CHECK(kind IN ('series','movie')),
      episode_key TEXT NOT NULL,
      monitor_future INTEGER NOT NULL CHECK(monitor_future IN (0,1)),
      watch_closed INTEGER NOT NULL DEFAULT 0 CHECK(watch_closed IN (0,1)),
      cancelled_ms INTEGER CHECK(cancelled_ms >= 0),
      created_ms INTEGER NOT NULL CHECK(created_ms >= 0),
      status TEXT NOT NULL CHECK(status = 'held'),
      reason TEXT NOT NULL,
      UNIQUE(requester_id,request_key)
    ) STRICT`);
    if (!db.prepare('PRAGMA table_info(requests)').all()
      .some((column) => column.name === 'command_key')) {
      db.exec('ALTER TABLE requests ADD COLUMN command_key TEXT');
    }
    if (!db.prepare('PRAGMA table_info(requests)').all()
      .some((column) => column.name === 'watch_closed')) {
      db.exec('ALTER TABLE requests ADD COLUMN watch_closed INTEGER NOT NULL DEFAULT 0 CHECK(watch_closed IN (0,1))');
    }
    if (!db.prepare('PRAGMA table_info(requests)').all()
      .some((column) => column.name === 'title')) {
      db.exec('ALTER TABLE requests ADD COLUMN title TEXT');
    }
    if (!db.prepare('PRAGMA table_info(requests)').all()
      .some((column) => column.name === 'cancelled_ms')) {
      db.exec('ALTER TABLE requests ADD COLUMN cancelled_ms INTEGER CHECK(cancelled_ms >= 0)');
    }
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
    db.exec(`CREATE TABLE IF NOT EXISTS airing_poll_cursor (
      id INTEGER PRIMARY KEY CHECK(id=1),
      after_id INTEGER NOT NULL CHECK(after_id>=0)
    ) STRICT`);
    db.exec('INSERT INTO airing_poll_cursor(id,after_id) VALUES (1,0) ON CONFLICT(id) DO NOTHING');
    db.exec('PRAGMA foreign_keys=ON');
  } catch (error) { db.close(); throw error; }

  const findRequest = db.prepare(`SELECT id,anidb_id,kind,episode_key,monitor_future,command_key,cancelled_ms
    FROM requests WHERE requester_id=? AND request_key=?`);
  const insertRequest = db.prepare(`INSERT INTO requests
    (requester_id,request_key,command_key,title,anidb_id,kind,episode_key,monitor_future,created_ms,status,reason)
    VALUES (?,?,?,?,?,?,?,?,?,'held',?)`);
  const insertTarget = db.prepare(`INSERT INTO targets(anidb_id,episode_id,status,reason)
    VALUES (?,?,'held',?) ON CONFLICT(anidb_id,episode_id) DO NOTHING`);
  const findTarget = db.prepare('SELECT id FROM targets WHERE anidb_id=? AND episode_id=?');
  const insertLink = db.prepare('INSERT INTO request_targets(request_id,target_id) VALUES (?,?)');
  const findLinks = db.prepare(`SELECT t.id,t.episode_id FROM targets t
    JOIN request_targets rt ON rt.target_id=t.id WHERE rt.request_id=? ORDER BY t.episode_id`);
  const get = db.prepare(`SELECT id,requester_id,title,anidb_id,kind,monitor_future,watch_closed,cancelled_ms,created_ms,status,reason
    FROM requests WHERE id=?`);
  const listOwn = db.prepare(`SELECT id FROM requests WHERE requester_id=? AND id<?
    ORDER BY id DESC LIMIT ?`);
  const listWatching = db.prepare(`SELECT id FROM requests WHERE requester_id=? AND id<?
    AND monitor_future=1 AND watch_closed=0 AND cancelled_ms IS NULL ORDER BY id DESC LIMIT ?`);
  const listHistory = db.prepare(`SELECT id FROM requests WHERE requester_id=? AND id<?
    AND (monitor_future=0 OR watch_closed=1 OR cancelled_ms IS NOT NULL) ORDER BY id DESC LIMIT ?`);
  const countRequests = db.prepare('SELECT COUNT(*) AS count FROM requests');
  const countTargets = db.prepare('SELECT COUNT(*) AS count FROM targets');
  const watchRow = db.prepare('SELECT anidb_id,kind,monitor_future,watch_closed,cancelled_ms FROM requests WHERE id=?');
  const closeWatch = db.prepare('UPDATE requests SET watch_closed=1 WHERE id=? AND watch_closed=0');
  const activeAirings = db.prepare(`SELECT id,anidb_id FROM requests
    WHERE id>? AND monitor_future=1 AND watch_closed=0 AND cancelled_ms IS NULL ORDER BY id LIMIT ?`);
  const cancelRow = db.prepare('SELECT requester_id,cancelled_ms FROM requests WHERE id=?');
  const cancel = db.prepare('UPDATE requests SET cancelled_ms=? WHERE id=? AND requester_id=? AND cancelled_ms IS NULL');
  const attemptTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='acquisition_attempts'");
  const readAiringCursor = db.prepare('SELECT after_id FROM airing_poll_cursor WHERE id=1');
  const updateAiringCursor = db.prepare('UPDATE airing_poll_cursor SET after_id=? WHERE id=1 AND after_id=?');

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
    cancelRequest({ requesterId, requestId, nowMs }) {
      if (![requesterId, requestId].every((id) => Number.isSafeInteger(id) && id > 0) ||
          !Number.isSafeInteger(nowMs) || nowMs < 0) {
        throw new TypeError('Invalid cancellation');
      }
      return transact(() => {
        const row = cancelRow.get(requestId);
        if (!row || row.requester_id !== requesterId) return held('request_not_found');
        if (row.cancelled_ms !== null) return { state: 'cancelled', requestId };
        if (attemptTable.get() && db.prepare(
          'SELECT 1 FROM acquisition_attempts WHERE request_id=? LIMIT 1').get(requestId)) {
          return held('acquisition_started');
        }
        cancel.run(nowMs, requestId, requesterId);
        return { state: 'cancelled', requestId };
      });
    },
    listRequests({ requesterId, beforeId = Number.MAX_SAFE_INTEGER, limit = 20,
      view = 'all' }) {
      if (!Number.isSafeInteger(requesterId) || requesterId < 1 ||
          !Number.isSafeInteger(beforeId) || beforeId < 1 ||
          !Number.isSafeInteger(limit) || limit < 1 || limit > 50 ||
          !['all', 'watching', 'history'].includes(view)) {
        throw new TypeError('Invalid request history page');
      }
      const statement = view === 'watching' ? listWatching :
        view === 'history' ? listHistory : listOwn;
      const rows = statement.all(requesterId, beforeId, limit + 1);
      const items = rows.slice(0, limit).map((row) => this.getRequest(row.id));
      return { items, nextBeforeId: rows.length > limit ? items.at(-1).id : null };
    },
    getAiringCursor() { return readAiringCursor.get().after_id; },
    advanceAiringCursor({ expectedAfterId, nextAfterId }) {
      if (![expectedAfterId, nextAfterId].every((id) => Number.isSafeInteger(id) && id >= 0) ||
          (nextAfterId !== 0 && nextAfterId <= expectedAfterId)) {
        throw new TypeError('Invalid airing cursor advancement');
      }
      return transact(() => updateAiringCursor.run(nextAfterId, expectedAfterId).changes === 1
        ? { state: 'advanced', afterId: nextAfterId }
        : held('stale_cursor'));
    },
    listActiveAirings({ afterId = 0, limit = 20 } = {}) {
      if (!Number.isSafeInteger(afterId) || afterId < 0 ||
          !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
        throw new TypeError('Invalid airing watch page');
      }
      return activeAirings.all(afterId, limit).map((row) => ({
        requestId: row.id, anidbId: row.anidb_id }));
    },
    // The original submission episode_key is immutable for idempotency.
    // Later aired episodes are appended as shared targets in one transaction.
    advanceAiring({ requestId, detail, releaseState, today }) {
      if (!Number.isSafeInteger(requestId) || requestId <= 0 ||
          !validFullDate(today) ||
          !['airing', 'completed'].includes(releaseState)) {
        throw new TypeError('Invalid airing observation');
      }
      return transact(() => {
        const watch = watchRow.get(requestId);
        if (!watch) return held('request_missing');
        if (watch.monitor_future !== 1 || watch.kind !== 'series') return held('not_airing_request');
        if (watch.watch_closed === 1 || watch.cancelled_ms !== null) return held('watch_closed');
        if (!isCompleteAniDbDetail(detail, watch.anidb_id,
          { allowEmptySeries: true }) || detail.kind !== 'series' ||
            detail.episodes.length > 2_000) {
          return held('detail_incomplete');
        }
        const regular = detail.episodes.filter((episode) => episode.type === 'Episode');
        const byId = new Map(regular.map((episode) => [episode.id, episode]));
        const linked = findLinks.all(requestId).map((row) => row.episode_id);
        if (linked.some((id) => !byId.has(id))) return held('catalogue_regression');
        const linkedIds = new Set(linked);
        const pending = regular.filter((episode) => !linkedIds.has(episode.id));
        const eligible = releaseState === 'completed' ? pending : pending.filter((episode) =>
          validFullDate(episode.airDate) &&
          episode.airDate <= today);
        const selected = eligible.slice(0, 25);
        const addedEpisodeIds = [];
        for (const episode of selected) {
          insertTarget.run(watch.anidb_id, episode.id, REASON);
          insertLink.run(requestId, findTarget.get(watch.anidb_id, episode.id).id);
          addedEpisodeIds.push(episode.id);
        }
        // An end date can arrive before AniDB lists the final episode. Keep
        // polling until the detail includes its stated regular-episode count.
        const watchClosed = releaseState === 'completed' &&
          hasStatedRegularEpisodes(detail) && selected.length === pending.length;
        if (watchClosed) closeWatch.run(requestId);
        return { state: 'advanced', addedEpisodeIds: addedEpisodeIds.sort((a, b) => a - b),
          deferredEpisodeIds: pending.filter((episode) => !selected.includes(episode))
            .map((episode) => episode.id).sort((a, b) => a - b), watchClosed };
      });
    },
    findSubmission({ requesterId, requestKey, commandKey }) {
      if (!Number.isSafeInteger(requesterId) || requesterId <= 0 ||
          typeof requestKey !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(requestKey) ||
          typeof commandKey !== 'string' || commandKey.length > 20_000) {
        throw new TypeError('Invalid submission lookup');
      }
      const existing = findRequest.get(requesterId, requestKey);
      if (!existing) return null;
      if (existing.cancelled_ms !== null) return held('request_cancelled');
      if (existing.command_key !== commandKey) return held('idempotency_key_conflict');
      return { state: 'held', reason: REASON, requestId: existing.id,
        targetIds: findLinks.all(existing.id).map((row) => row.id), created: false };
    },
    submit({ requesterId, requestKey, commandKey = null, intent, nowMs }) {
      if (!Number.isSafeInteger(requesterId) || requesterId <= 0 ||
          typeof requestKey !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(requestKey) ||
          !Number.isSafeInteger(nowMs) || nowMs < 0 ||
          (commandKey !== null && (typeof commandKey !== 'string' || commandKey.length > 20_000))) {
        throw new TypeError('Invalid requester or time');
      }
      const item = canonicalIntent(intent);
      return transact(() => {
        const existing = findRequest.get(requesterId, requestKey);
        if (existing) {
          if (existing.cancelled_ms !== null) return held('request_cancelled');
          if (existing.command_key !== commandKey ||
              existing.anidb_id !== item.anidbId || existing.kind !== item.kind ||
              existing.episode_key !== item.episodeKey ||
              existing.monitor_future !== Number(item.monitorFuture)) {
            return { state: 'held', reason: 'idempotency_key_conflict' };
          }
          return { state: 'held', reason: REASON, requestId: existing.id,
            targetIds: findLinks.all(existing.id).map((row) => row.id), created: false };
        }
        const requestId = Number(insertRequest.run(requesterId, requestKey, commandKey, item.title, item.anidbId,
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
        ...(row.title === null ? {} : { title: row.title }),
        kind: row.kind, monitorFuture: Boolean(row.monitor_future),
        watchClosed: Boolean(row.watch_closed),
        episodeIds: findLinks.all(row.id).map((link) => link.episode_id),
        status: row.cancelled_ms === null ? row.status : 'cancelled',
        reason: row.reason, createdMs: row.created_ms } : null;
    },
    countRequests() { return countRequests.get().count; },
    countTargets() { return countTargets.get().count; },
    close() { db.close(); },
  };
}
