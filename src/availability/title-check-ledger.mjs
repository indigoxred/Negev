import { DatabaseSync } from 'node:sqlite';

const validId = (value) => Number.isSafeInteger(value) && value > 0;
const validTime = (value) => Number.isSafeInteger(value) && value >= 0;
const leaseMs = 10 * 60_000;
const positiveLifetimeMs = 30 * 60_000;

// A title check is a durable, bounded read job. Its stored positive is never
// media proof by itself; callers must use only recent exact observer results.
export function openTitleCheckLedger(dbPath) {
  if (typeof dbPath !== 'string' || !dbPath || dbPath === ':memory:') {
    throw new TypeError('Durable title-check database required');
  }
  const db = new DatabaseSync(dbPath, { timeout: 5_000 });
  try {
    db.exec('PRAGMA journal_mode=WAL');
    db.exec(`CREATE TABLE IF NOT EXISTS title_check_jobs (
      anidb_id INTEGER PRIMARY KEY CHECK(anidb_id>0),
      generation INTEGER NOT NULL CHECK(generation>0),
      state TEXT NOT NULL CHECK(state IN ('loading','checking','done','held')),
      kind TEXT CHECK(kind IN ('series','movie')),
      total_count INTEGER CHECK(total_count>=0 AND total_count<=10000),
      next_page INTEGER NOT NULL CHECK(next_page>0 AND next_page<=1000),
      version INTEGER NOT NULL CHECK(version>0),
      requested_ms INTEGER NOT NULL CHECK(requested_ms>=0),
      lease_until_ms INTEGER NOT NULL CHECK(lease_until_ms>=0)
    ) STRICT`);
    db.exec(`CREATE TABLE IF NOT EXISTS title_check_targets (
      anidb_id INTEGER NOT NULL,
      generation INTEGER NOT NULL CHECK(generation>0),
      ordinal INTEGER NOT NULL CHECK(ordinal>=0),
      episode_id INTEGER NOT NULL CHECK(episode_id>0),
      state TEXT NOT NULL CHECK(state IN ('pending','available','unknown')),
      checked_ms INTEGER,
      PRIMARY KEY(anidb_id,generation,episode_id),
      UNIQUE(anidb_id,generation,ordinal),
      FOREIGN KEY(anidb_id) REFERENCES title_check_jobs(anidb_id)
    ) STRICT`);
    db.exec(`CREATE INDEX IF NOT EXISTS title_check_next_target ON
      title_check_targets(anidb_id,generation,state,ordinal)`);
    db.exec('PRAGMA foreign_keys=ON');
  } catch (error) { db.close(); throw error; }
  const transaction = (work) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const find = db.prepare(`SELECT anidb_id AS anidbId,generation,state,kind,
    total_count AS totalCount,next_page AS nextPage,version,
    lease_until_ms AS leaseUntilMs FROM title_check_jobs WHERE anidb_id=?`);
  const add = db.prepare(`INSERT INTO title_check_jobs
    (anidb_id,generation,state,next_page,version,requested_ms,lease_until_ms)
    VALUES (?,1,'loading',1,1,?,0)`);
  const restart = db.prepare(`UPDATE title_check_jobs SET generation=generation+1,
    state='loading',kind=NULL,total_count=NULL,next_page=1,version=version+1,
    requested_ms=?,lease_until_ms=0 WHERE anidb_id=?`);
  const clearTargets = db.prepare(`DELETE FROM title_check_targets WHERE anidb_id=?`);
  const due = db.prepare(`SELECT anidb_id AS anidbId FROM title_check_jobs
    WHERE state IN ('loading','checking') AND lease_until_ms<=?
    ORDER BY requested_ms,anidb_id LIMIT 1`);
  const claim = db.prepare(`UPDATE title_check_jobs SET version=version+1,
    lease_until_ms=? WHERE anidb_id=? AND version=?`);
  const countTargets = db.prepare(`SELECT COUNT(*) AS count FROM title_check_targets
    WHERE anidb_id=? AND generation=?`);
  const nextTarget = db.prepare(`SELECT episode_id AS episodeId FROM title_check_targets
    WHERE anidb_id=? AND generation=? AND state='pending'
    ORDER BY ordinal LIMIT 1`);
  const hasTarget = db.prepare(`SELECT 1 FROM title_check_targets
    WHERE anidb_id=? AND generation=? AND episode_id=?`);
  const targetStatus = db.prepare(`SELECT state,checked_ms AS checkedMs
    FROM title_check_targets WHERE anidb_id=? AND generation=? AND episode_id=?`);
  const resetTarget = db.prepare(`UPDATE title_check_targets
    SET state='pending',checked_ms=NULL WHERE anidb_id=? AND generation=?
    AND episode_id=?`);
  const requeueJob = db.prepare(`UPDATE title_check_jobs SET
    state=CASE WHEN state='done' THEN 'checking' ELSE state END,
    version=version+1,lease_until_ms=0 WHERE anidb_id=? AND generation=?`);
  const addTarget = db.prepare(`INSERT INTO title_check_targets
    (anidb_id,generation,ordinal,episode_id,state)
    VALUES (?,?,?,?,'pending')`);
  const recordPage = db.prepare(`UPDATE title_check_jobs SET kind=?,
    total_count=?,next_page=?,state=?,lease_until_ms=0
    WHERE anidb_id=? AND generation=? AND version=?`);
  const hold = db.prepare(`UPDATE title_check_jobs SET state='held',
    lease_until_ms=0 WHERE anidb_id=? AND generation=? AND version=?`);
  const recordTarget = db.prepare(`UPDATE title_check_targets SET state=?,checked_ms=?
    WHERE anidb_id=? AND generation=? AND episode_id=? AND state='pending'`);
  const release = db.prepare(`UPDATE title_check_jobs SET lease_until_ms=0,
    state=? WHERE anidb_id=? AND generation=? AND version=?`);
  const defer = db.prepare(`UPDATE title_check_jobs SET lease_until_ms=?
    WHERE anidb_id=? AND generation=? AND version=?`);
  const counts = db.prepare(`SELECT COUNT(*) AS checkedCount,
    COALESCE(SUM(CASE WHEN state='available' AND checked_ms>? AND
      checked_ms<=? THEN 1 ELSE 0 END),0) AS recentAvailableCount
    FROM title_check_targets WHERE anidb_id=? AND generation=?
      AND state<>'pending'`);
  const validReceipt = (receipt, state) =>
    receipt?.state === state && validId(receipt.anidbId) &&
    validId(receipt.generation) && validId(receipt.version);
  return {
    start({ anidbId, nowMs }) {
      if (!validId(anidbId) || !validTime(nowMs)) {
        throw new TypeError('Invalid title-check start');
      }
      return transaction(() => {
        const old = find.get(anidbId);
        if (!old) {
          add.run(anidbId, nowMs);
          return { state: 'queued', generation: 1 };
        }
        if (['loading', 'checking'].includes(old.state)) {
          return { state: 'shared', generation: old.generation };
        }
        if (!validId(old.generation + 1)) {
          return { state: 'held', reason: 'generation_exhausted' };
        }
        clearTargets.run(anidbId);
        restart.run(nowMs, anidbId);
        return { state: 'queued', generation: old.generation + 1 };
      });
    },
    claimNext({ nowMs }) {
      if (!validTime(nowMs) || !validTime(nowMs + leaseMs)) {
        throw new TypeError('Invalid title-check clock');
      }
      return transaction(() => {
        const selection = due.get(nowMs);
        if (!selection) return { state: 'idle' };
        const job = find.get(selection.anidbId);
        const episode = job.state === 'checking' ? nextTarget.get(job.anidbId,
          job.generation) : null;
        if (job.state === 'checking' && !episode) {
          release.run('done', job.anidbId, job.generation, job.version);
          return { state: 'idle' };
        }
        const updated = claim.run(nowMs + leaseMs, job.anidbId, job.version);
        if (updated.changes !== 1) return { state: 'idle' };
        return { state: job.state === 'loading' ? 'claimed_page' : 'claimed_target',
          anidbId: job.anidbId, generation: job.generation,
          version: job.version + 1,
          ...(job.state === 'loading' ? { page: job.nextPage } :
            { episodeId: episode.episodeId, kind: job.kind }) };
      });
    },
    recordPage({ claim: receipt, detail, checkedMs }) {
      if (!validReceipt(receipt, 'claimed_page') || !validId(receipt.page) ||
          !validTime(checkedMs)) throw new TypeError('Invalid title page result');
      return transaction(() => {
        const job = find.get(receipt.anidbId);
        if (job?.generation !== receipt.generation ||
            job.version !== receipt.version || job.state !== 'loading' ||
            job.nextPage !== receipt.page) return { state: 'held', reason: 'stale_claim' };
        const episodes = detail?.episodes;
        const valid = detail?.state === 'details' &&
          detail.anidbId === receipt.anidbId && detail.page === receipt.page &&
          ['series', 'movie'].includes(detail.kind) &&
          Number.isSafeInteger(detail.total) && detail.total >= 0 &&
          detail.total <= 10_000 && Array.isArray(episodes) &&
          episodes.length <= 100 && episodes.every((item) => validId(item?.id)) &&
          new Set(episodes?.map((item) => item.id)).size === episodes?.length &&
          (detail.nextPage === null ||
            (detail.nextPage === receipt.page + 1 && detail.nextPage <= 100 &&
              episodes.length > 0)) &&
          receipt.page <= 100;
        if (!valid) {
          hold.run(receipt.anidbId, receipt.generation, receipt.version);
          return { state: 'held', reason: 'catalogue_changed' };
        }
        const priorCount = countTargets.get(receipt.anidbId, receipt.generation).count;
        const changed = (job.kind !== null && job.kind !== detail.kind) ||
          (job.totalCount !== null && job.totalCount !== detail.total) ||
          priorCount + episodes.length > detail.total ||
          (detail.nextPage === null && priorCount + episodes.length !== detail.total) ||
          (detail.nextPage !== null && priorCount + episodes.length >= detail.total) ||
          episodes.some((item) => hasTarget.get(receipt.anidbId,
            receipt.generation, item.id));
        if (changed) {
          hold.run(receipt.anidbId, receipt.generation, receipt.version);
          return { state: 'held', reason: 'catalogue_changed' };
        }
        for (let i = 0; i < episodes.length; i++) {
          addTarget.run(receipt.anidbId, receipt.generation,
            priorCount + i, episodes[i].id);
        }
        recordPage.run(detail.kind, detail.total, detail.nextPage ?? receipt.page,
          detail.nextPage === null
            ? (detail.total === 0 ? 'done' : 'checking') : 'loading',
          receipt.anidbId, receipt.generation, receipt.version);
        return { state: 'recorded_page' };
      });
    },
    recordTarget({ claim: receipt, status, checkedMs }) {
      if (!validReceipt(receipt, 'claimed_target') || !validId(receipt.episodeId) ||
          !['available', 'unknown'].includes(status) || !validTime(checkedMs)) {
        throw new TypeError('Invalid title target result');
      }
      return transaction(() => {
        const job = find.get(receipt.anidbId);
        if (job?.generation !== receipt.generation ||
            job.version !== receipt.version || job.state !== 'checking') {
          return { state: 'held', reason: 'stale_claim' };
        }
        if (recordTarget.run(status, checkedMs, receipt.anidbId,
          receipt.generation, receipt.episodeId).changes !== 1) {
          return { state: 'held', reason: 'stale_claim' };
        }
        const state = nextTarget.get(receipt.anidbId, receipt.generation)
          ? 'checking' : 'done';
        release.run(state, receipt.anidbId, receipt.generation, receipt.version);
        return { state: 'recorded_target' };
      });
    },
    invalidateTarget({ anidbId, episodeId, observedMs }) {
      if (!validId(anidbId) || !validId(episodeId) || !validTime(observedMs)) {
        throw new TypeError('Invalid title target invalidation');
      }
      return transaction(() => {
        const job = find.get(anidbId);
        if (!job) return { state: 'unchanged' };
        const target = targetStatus.get(anidbId, job.generation, episodeId);
        if (!target || target.state === 'pending' ||
            !validTime(target.checkedMs) || target.checkedMs >= observedMs) {
          return { state: 'unchanged' };
        }
        resetTarget.run(anidbId, job.generation, episodeId);
        requeueJob.run(anidbId, job.generation);
        return { state: 'queued' };
      });
    },
    defer({ claim: receipt, retryAtMs }) {
      if (!(validReceipt(receipt, 'claimed_page') ||
          validReceipt(receipt, 'claimed_target')) || !validTime(retryAtMs)) {
        throw new TypeError('Invalid title-check retry');
      }
      return transaction(() => {
        const job = find.get(receipt.anidbId);
        if (job?.generation !== receipt.generation ||
            job.version !== receipt.version ||
            job.state !== (receipt.state === 'claimed_page'
              ? 'loading' : 'checking')) {
          return { state: 'held', reason: 'stale_claim' };
        }
        defer.run(retryAtMs, receipt.anidbId,
          receipt.generation, receipt.version);
        return { state: 'deferred' };
      });
    },
    getProgress({ anidbId, nowMs }) {
      if (!validId(anidbId) || !validTime(nowMs)) {
        throw new TypeError('Invalid title-check progress query');
      }
      const job = find.get(anidbId);
      if (!job) return null;
      const row = counts.get(nowMs - positiveLifetimeMs, nowMs,
        anidbId, job.generation);
      return { state: job.state, generation: job.generation,
        totalCount: job.totalCount, checkedCount: row.checkedCount,
        recentAvailableCount: row.recentAvailableCount };
    },
    getTargetStatus({ anidbId, episodeId, nowMs }) {
      if (!validId(anidbId) || !validId(episodeId) || !validTime(nowMs)) {
        throw new TypeError('Invalid title target status query');
      }
      const job = find.get(anidbId);
      const row = job && targetStatus.get(anidbId, job.generation, episodeId);
      return row?.state === 'available' && validTime(row.checkedMs) &&
        row.checkedMs <= nowMs && row.checkedMs + positiveLifetimeMs > nowMs
        ? { state: 'available' } : { state: 'unknown' };
    },
    close() { db.close(); },
  };
}
