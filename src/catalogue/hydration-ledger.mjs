import { DatabaseSync } from 'node:sqlite';
import { planHydration } from './plan-hydration.mjs';

const LEASE_MS = 10 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
const held = (reason) => ({ state: 'held', reason });

export function isCompleteAniDbDetail(detail, anidbId) {
  if (detail?.state !== 'details' || detail.anidbId !== anidbId ||
      detail.complete !== true || !Number.isSafeInteger(detail.total) ||
      detail.total < 1 || !Array.isArray(detail.episodes) ||
      detail.episodes.length !== detail.total) return false;
  const ids = new Set();
  for (const episode of detail.episodes) {
    if (!Number.isSafeInteger(episode?.id) || episode.id <= 0 || ids.has(episode.id) ||
        typeof episode.type !== 'string') return false;
    ids.add(episode.id);
  }
  return detail.episodes.some((episode) => episode.type === 'Episode');
}

// Prototype storage boundary. It never calls Shoko. A future worker must
// reserve, persist dispatch intent, submit once, and reconcile uncertain
// outcomes before retrying. Opening one DB path from multiple workers is safe.
export function openHydrationLedger(dbPath) {
  if (typeof dbPath !== 'string' || !dbPath || dbPath === ':memory:') {
    throw new TypeError('A durable hydration database path is required');
  }
  const db = new DatabaseSync(dbPath, { timeout: 5_000 });
  try {
    db.exec('PRAGMA journal_mode=WAL');
    db.exec(`CREATE TABLE IF NOT EXISTS hydration_claims (
      id INTEGER PRIMARY KEY,
      anidb_id INTEGER NOT NULL CHECK(anidb_id > 0),
      claimed_ms INTEGER NOT NULL CHECK(claimed_ms >= 0),
      lease_until_ms INTEGER NOT NULL CHECK(lease_until_ms > claimed_ms),
      status TEXT NOT NULL CHECK(status IN ('reserved', 'completed')),
      completed_ms INTEGER
    ) STRICT`);
    db.exec('CREATE INDEX IF NOT EXISTS hydration_claims_title_time ON hydration_claims(anidb_id, claimed_ms DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS hydration_claims_time ON hydration_claims(claimed_ms DESC)');
  } catch (error) {
    db.close();
    throw error;
  }

  const latestTitle = db.prepare('SELECT claimed_ms FROM hydration_claims WHERE anidb_id=? ORDER BY claimed_ms DESC LIMIT 1');
  const latestGlobal = db.prepare('SELECT claimed_ms FROM hydration_claims ORDER BY claimed_ms DESC LIMIT 1');
  const active = db.prepare("SELECT COUNT(*) AS count FROM hydration_claims WHERE status='reserved' AND lease_until_ms>?");
  const recent = db.prepare('SELECT COUNT(*) AS count FROM hydration_claims WHERE claimed_ms>?');
  const insert = db.prepare("INSERT INTO hydration_claims(anidb_id,claimed_ms,lease_until_ms,status) VALUES(?,?,?,'reserved')");
  const find = db.prepare('SELECT id,anidb_id,claimed_ms,lease_until_ms,status FROM hydration_claims WHERE id=?');
  const latestReserved = db.prepare("SELECT id,anidb_id,claimed_ms,lease_until_ms,status FROM hydration_claims WHERE anidb_id=? AND status='reserved' ORDER BY claimed_ms DESC,id DESC LIMIT 1");
  const finish = db.prepare("UPDATE hydration_claims SET status='completed',completed_ms=? WHERE id=? AND status='reserved'");

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

  function completeClaim(claim, detail, nowMs) {
    if (nowMs < claim.claimed_ms || !isCompleteAniDbDetail(detail, claim.anidb_id)) {
      return held('invalid_detail_evidence');
    }
    finish.run(nowMs, claim.id);
    return { state: 'completed' };
  }

  return {
    reserve({ anidbId, titleKnown, detailState, nowMs }) {
      if (!Number.isSafeInteger(nowMs) || nowMs < 0 ||
          !Number.isSafeInteger(nowMs + LEASE_MS)) throw new TypeError('Invalid claim time');
      return transact(() => {
        const decision = planHydration({
          anidbId, titleKnown, detailState, nowMs,
          activeRefreshes: active.get(nowMs).count,
          attempts24h: recent.get(nowMs - DAY_MS).count,
          lastTitleAttemptMs: latestTitle.get(anidbId)?.claimed_ms ?? null,
          lastGlobalAttemptMs: latestGlobal.get()?.claimed_ms ?? null,
        });
        if (decision.state !== 'admit') return decision;
        const result = insert.run(anidbId, nowMs, nowMs + LEASE_MS);
        return { state: 'reserved', claimId: Number(result.lastInsertRowid),
          leaseUntilMs: nowMs + LEASE_MS };
      });
    },
    getClaim(claimId) {
      if (!Number.isSafeInteger(claimId) || claimId <= 0) throw new TypeError('Invalid claim ID');
      const row = find.get(claimId);
      return row ? {
        id: row.id, anidbId: row.anidb_id, claimedMs: row.claimed_ms,
        leaseUntilMs: row.lease_until_ms, status: row.status,
      } : null;
    },
    finishFromDetail(claimId, detail, nowMs) {
      if (!Number.isSafeInteger(claimId) || claimId <= 0 ||
          !Number.isSafeInteger(nowMs) || nowMs < 0) throw new TypeError('Invalid completion');
      return transact(() => {
        const claim = find.get(claimId);
        if (!claim) return held('claim_missing');
        if (claim.status === 'completed') return { state: 'completed' };
        return completeClaim(claim, detail, nowMs);
      });
    },
    finishLatestFromDetail(anidbId, detail, nowMs) {
      if (!Number.isSafeInteger(anidbId) || anidbId <= 0 ||
          !Number.isSafeInteger(nowMs) || nowMs < 0) throw new TypeError('Invalid completion');
      return transact(() => {
        const claim = latestReserved.get(anidbId);
        return claim ? completeClaim(claim, detail, nowMs) : { state: 'no_claim' };
      });
    },
    close() { db.close(); },
  };
}
