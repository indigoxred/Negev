import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { trustedReleaseQueries } from './trusted-release-queries.mjs';

const hashGuid = (guid) => createHash('sha256').update(guid).digest('hex');
const normalized = (value) => value.normalize('NFKD').toLowerCase()
  .replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const matchesTitle = (title, release) => {
  const target = normalized(title);
  const found = normalized(release);
  return target.length >= 6 && (` ${found} `).includes(` ${target} `);
};

// A feed hit only advances a guarded request's next check. It cannot select
// a torrent, change an import, or revive a suspended/cancelled request.
export function openReleaseFeedLedger(dbPath, { aliasesForId = () => [] } = {}) {
  if (typeof dbPath !== 'string' || !dbPath || dbPath === ':memory:' ||
      typeof aliasesForId !== 'function') {
    throw new TypeError('Durable feed ledger path required');
  }
  const db = new DatabaseSync(dbPath, { timeout: 5_000 });
  try {
    db.exec('PRAGMA journal_mode=WAL');
    db.exec(`CREATE TABLE IF NOT EXISTS rss_feed_state (
      indexer_id INTEGER PRIMARY KEY CHECK(indexer_id>0),
      last_success_ms INTEGER NOT NULL CHECK(last_success_ms>=0)) STRICT;
      CREATE TABLE IF NOT EXISTS rss_seen (
      indexer_id INTEGER NOT NULL CHECK(indexer_id>0),
      guid_hash TEXT NOT NULL CHECK(length(guid_hash)=64),
      observed_ms INTEGER NOT NULL CHECK(observed_ms>=0),
      PRIMARY KEY(indexer_id,guid_hash)) STRICT;
      CREATE INDEX IF NOT EXISTS rss_seen_age ON rss_seen(indexer_id,observed_ms);`);
    db.exec(`CREATE TABLE IF NOT EXISTS rss_watch_timing (
      request_id INTEGER PRIMARY KEY REFERENCES requests(id),
      next_metadata_ms INTEGER NOT NULL CHECK(next_metadata_ms>=0),
      feed_interval_ms INTEGER NOT NULL CHECK(feed_interval_ms>0),
      rush_until_ms INTEGER NOT NULL DEFAULT 0 CHECK(rush_until_ms>=0)
    ) STRICT`);
  } catch (error) { db.close(); throw error; }
  const state = db.prepare('SELECT last_success_ms FROM rss_feed_state WHERE indexer_id=?');
  const insertState = db.prepare(`INSERT INTO rss_feed_state VALUES (?,?)
    ON CONFLICT(indexer_id) DO UPDATE SET last_success_ms=excluded.last_success_ms`);
  const insertSeen = db.prepare('INSERT OR IGNORE INTO rss_seen VALUES (?,?,?)');
  const watches = db.prepare(`SELECT r.id,r.title,r.anidb_id AS anidbId FROM requests r
    LEFT JOIN acquisition_request_suspensions s ON s.request_id=r.id
    WHERE r.status='held' AND r.cancelled_ms IS NULL AND
      r.monitor_future=1 AND r.watch_closed=0 AND s.request_id IS NULL AND
      r.title IS NOT NULL
    ORDER BY r.id LIMIT 500`);
  const interval = db.prepare(`SELECT MIN(CASE WHEN wt.rush_until_ms>? THEN 3600000
      ELSE COALESCE(wt.feed_interval_ms,3600000) END) AS interval_ms
    FROM requests r LEFT JOIN rss_watch_timing wt ON wt.request_id=r.id
    LEFT JOIN acquisition_request_suspensions s ON s.request_id=r.id
    WHERE r.status='held' AND r.cancelled_ms IS NULL AND
      r.monitor_future=1 AND r.watch_closed=0 AND s.request_id IS NULL`);
  const rush = db.prepare(`INSERT INTO rss_watch_timing
    (request_id,next_metadata_ms,feed_interval_ms,rush_until_ms)
    VALUES (?,?,3600000,?) ON CONFLICT(request_id) DO UPDATE SET
      next_metadata_ms=MIN(next_metadata_ms,excluded.next_metadata_ms),
      rush_until_ms=MAX(rush_until_ms,excluded.rush_until_ms)`);
  const wake = db.prepare(`UPDATE acquisition_request_checks
    SET next_due_ms=? WHERE request_id=? AND state='held' AND
      reason IN ('no_release_candidates','no_safe_release') AND next_due_ms>?`);
  const prune = db.prepare('DELETE FROM rss_seen WHERE indexer_id=? AND observed_ms<?');
  const cap = db.prepare(`DELETE FROM rss_seen WHERE indexer_id=? AND guid_hash NOT IN
    (SELECT guid_hash FROM rss_seen WHERE indexer_id=?
      ORDER BY observed_ms DESC LIMIT 2000)`);
  return {
    getPollIntervalMs({ nowMs = Date.now() } = {}) {
      if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
        throw new TypeError('Invalid feed clock');
      }
      return interval.get(nowMs).interval_ms ?? null;
    },
    accept({ indexerId, items, nowMs } = {}) {
      if (!Number.isSafeInteger(indexerId) || indexerId < 1 ||
          !Number.isSafeInteger(nowMs) || nowMs < 0 ||
          !Array.isArray(items) || items.length > 1_000 ||
          items.some((item) => item?.indexerId !== indexerId ||
            typeof item.guid !== 'string' || !item.guid || item.guid.length > 3_400 ||
            typeof item.title !== 'string' || !item.title || item.title.length > 500 ||
            (item.publishedMs !== null &&
              (!Number.isSafeInteger(item.publishedMs) || item.publishedMs < 0)))) {
        throw new TypeError('Invalid release feed page');
      }
      let begun = false;
      try {
        db.exec('BEGIN IMMEDIATE'); begun = true;
        const seeded = Boolean(state.get(indexerId));
        const active = seeded ? watches.all() : [];
        const terms = active.map((request) => {
          let aliases = [];
          try { aliases = aliasesForId(request.anidbId); } catch { /* Title remains usable. */ }
          return { id: request.id, terms: trustedReleaseQueries(request.title,
            Array.isArray(aliases) ? aliases : []) };
        });
        const woken = new Set();
        let newItems = 0;
        for (const item of items) {
          if (insertSeen.run(indexerId, hashGuid(item.guid), nowMs).changes === 0) continue;
          if (!seeded) continue;
          newItems++;
          for (const request of terms) {
            if (!request.terms.some((term) => matchesTitle(term, item.title))) continue;
            const timing = rush.run(request.id, nowMs,
              nowMs + 24 * 60 * 60_000);
            const queue = wake.run(nowMs, request.id, nowMs);
            if (timing.changes === 1 || queue.changes === 1) woken.add(request.id);
          }
        }
        insertState.run(indexerId, nowMs);
        prune.run(indexerId, Math.max(0, nowMs - 14 * 24 * 60 * 60_000));
        cap.run(indexerId, indexerId);
        db.exec('COMMIT'); begun = false;
        return { state: seeded ? 'processed' : 'seeded', newItems,
          wokenRequests: woken.size };
      } catch (error) {
        if (begun) db.exec('ROLLBACK');
        throw error;
      }
    },
    close() { db.close(); },
  };
}
