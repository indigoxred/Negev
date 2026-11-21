import { torrentFileKind } from './evaluate-stopped-manifest.mjs';

const validId = (value) => Number.isSafeInteger(value) && value > 0;
const validTime = (value) => Number.isSafeInteger(value) && value >= 0;
const held = (reason) => ({ state: 'held', reason });
const kinds = new Set(['ova', 'movie', 'extra', 'special']);
const ranks = { selected: 0, published: 1, identified: 2, playable: 3 };
const statuses = new Set([...Object.keys(ranks), 'attention', 'skipped']);
function canonicalFiles(files) {
  if (!Array.isArray(files) || files.length > 20) throw new TypeError('Invalid bonus plan');
  const names = new Set();
  const targets = new Set();
  return files.map((file) => {
    if (typeof file?.name !== 'string' || file.name.length > 1000 ||
        torrentFileKind(file.name) !== 'video' || !validId(file.size) || file.size > 1024 ** 4 ||
        !validId(file.anidbId) || !Array.isArray(file.episodeIds) ||
        file.episodeIds.length !== 1 || !validId(file.episodeIds[0]) ||
        !kinds.has(file.kind) || file.evidence !== 'shoko_filename_prediction') {
      throw new TypeError('Invalid bonus file');
    }
    const name = file.name.toLowerCase();
    const target = `${file.anidbId}:${file.episodeIds[0]}`;
    if (names.has(name) || targets.has(target)) throw new TypeError('Duplicate bonus file or target');
    names.add(name); targets.add(target);
    return { name: file.name, size: file.size, anidbId: file.anidbId,
      episodeIds: [file.episodeIds[0]], kind: file.kind, evidence: file.evidence };
  }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}
const canonicalRow = (row) => ({ name: row.file_name, size: row.size,
  anidbId: row.anidb_id, episodeIds: [row.episode_id], kind: row.kind, evidence: row.evidence });

// Bonuses own independent claims; their lifecycle never changes requested main targets.
export function createBonusPackLedger(db) {
  for (const table of ['requests', 'acquisition_attempts', 'acquisition_starts',
    'acquisition_file_plans', 'acquisition_target_claims']) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
      throw new TypeError('Acquisition ledger must be initialized first');
    }
  }
  db.exec(`CREATE TABLE IF NOT EXISTS acquisition_bonus_files (
    attempt_id INTEGER NOT NULL REFERENCES acquisition_attempts(id),
    file_name TEXT NOT NULL CHECK(length(file_name) BETWEEN 1 AND 1000),
    size INTEGER NOT NULL CHECK(size BETWEEN 1 AND 1099511627776),
    anidb_id INTEGER NOT NULL CHECK(anidb_id>0),
    episode_id INTEGER NOT NULL CHECK(episode_id>0),
    kind TEXT NOT NULL CHECK(kind IN ('ova','movie','extra','special')),
    evidence TEXT NOT NULL CHECK(evidence='shoko_filename_prediction'),
    status TEXT NOT NULL CHECK(status IN ('selected','published','identified','playable','attention','skipped')),
    active INTEGER NOT NULL CHECK(active IN (0,1)),
    shoko_file_id INTEGER CHECK(shoko_file_id>0),
    reason TEXT CHECK(length(reason) BETWEEN 1 AND 500),
    next_check_ms INTEGER NOT NULL CHECK(next_check_ms>=0),
    checked_ms INTEGER NOT NULL CHECK(checked_ms>=0),
    created_ms INTEGER NOT NULL CHECK(created_ms>=0),
    progress_stage INTEGER NOT NULL DEFAULT 0 CHECK(progress_stage BETWEEN 0 AND 3),
    PRIMARY KEY(attempt_id,file_name),
    CHECK(status NOT IN ('identified','playable') OR shoko_file_id IS NOT NULL),
    CHECK(active=0 OR status NOT IN ('playable','skipped'))
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS active_acquisition_bonus_target
    ON acquisition_bonus_files(anidb_id,episode_id) WHERE active=1;
  CREATE TABLE IF NOT EXISTS acquisition_bonus_plans (
    attempt_id INTEGER PRIMARY KEY REFERENCES acquisition_attempts(id),
    torrent_hash TEXT NOT NULL,
    input_json TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_ms INTEGER NOT NULL CHECK(created_ms>=0)
  ) STRICT`);
  const transaction = (run) => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = run(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const attempt = db.prepare('SELECT * FROM acquisition_attempts WHERE id=?');
  const rows = db.prepare('SELECT * FROM acquisition_bonus_files WHERE attempt_id=? ORDER BY file_name');
  const hasTable = (name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  const terminated = (id) => ['acquisition_retirements', 'acquisition_rejections',
    'acquisition_prestart_mismatch_retirements'].some((table) => hasTable(table) &&
      db.prepare(`SELECT 1 FROM ${table} WHERE attempt_id=?`).get(id));
  return {
    recordBonusPlan({ attemptId, hash, files, nowMs }) {
      if (!validId(attemptId) || !validTime(nowMs) || typeof hash !== 'string' ||
          !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(hash)) throw new TypeError('Invalid bonus plan');
      const canonical = canonicalFiles(files);
      const normalizedHash = hash.toLowerCase();
      return transaction(() => {
        const parent = attempt.get(attemptId);
        if (!parent) return held('attempt_missing');
        if (parent.expected_hash !== normalizedHash) return held('torrent_conflict');
        const existing = db.prepare('SELECT * FROM acquisition_bonus_plans WHERE attempt_id=?').get(attemptId);
        if (existing) return existing.torrent_hash === normalizedHash &&
          existing.input_json === JSON.stringify(canonical)
          ? JSON.parse(existing.result_json) : held('bonus_plan_conflict');
        if (parent.status !== 'reserved' || terminated(attemptId) ||
            db.prepare('SELECT 1 FROM acquisition_starts WHERE attempt_id=?').get(attemptId)) return held('dispatch_already_begun');
        const main = db.prepare('SELECT * FROM acquisition_file_plans WHERE attempt_id=?').all(attemptId);
        if (!main.length) return held('main_plan_missing');
        const mainNames = new Set(main.map((file) => file.file_name.toLowerCase()));
        const mainIds = new Set(main.flatMap((file) => JSON.parse(file.episode_key)));
        if (canonical.some((file) => mainNames.has(file.name.toLowerCase()) ||
            (file.anidbId === parent.anidb_id && mainIds.has(file.episodeIds[0])))) return held('main_plan_conflict');
        const selected = [], skipped = [];
        for (const file of canonical) {
          const busy = db.prepare(`SELECT 1 FROM acquisition_target_claims
            WHERE anidb_id=? AND episode_id=? AND active=1`).get(file.anidbId, file.episodeIds[0]) ||
            db.prepare(`SELECT 1 FROM acquisition_bonus_files WHERE anidb_id=? AND episode_id=? AND active=1`)
              .get(file.anidbId, file.episodeIds[0]);
          if (busy) { skipped.push({ name: file.name, reason: 'target_busy' }); continue; }
          db.prepare(`INSERT INTO acquisition_bonus_files
            (attempt_id,file_name,size,anidb_id,episode_id,kind,evidence,status,active,next_check_ms,checked_ms,created_ms)
            VALUES (?,?,?,?,?,?,?,'selected',1,?,?,?)`).run(attemptId, file.name, file.size,
              file.anidbId, file.episodeIds[0], file.kind, file.evidence, nowMs, nowMs, nowMs);
          selected.push(file);
        }
        const result = { state: 'planned', files: selected, skipped };
        db.prepare('INSERT INTO acquisition_bonus_plans VALUES(?,?,?,?,?)').run(attemptId,
          normalizedHash, JSON.stringify(canonical), JSON.stringify(result), nowMs);
        return result;
      });
    },
    getBonusPlan(attemptId) {
      if (!validId(attemptId)) throw new TypeError('Invalid bonus attempt');
      return rows.all(attemptId).map(canonicalRow);
    },
    listPendingBonuses({ nowMs, limit = 5 }) {
      if (!validTime(nowMs) || !validId(limit) || limit > 100) throw new TypeError('Invalid bonus check');
      // Releases concern only main targets. A released main may still own pending bonuses.
      const exclusions = ['acquisition_retirements', 'acquisition_rejections',
        'acquisition_prestart_mismatch_retirements'].filter(hasTable)
        .map((table) => `AND NOT EXISTS(SELECT 1 FROM ${table} t WHERE t.attempt_id=b.attempt_id)`).join(' ');
      return db.prepare(`SELECT b.* FROM acquisition_bonus_files b
        JOIN acquisition_attempts a ON a.id=b.attempt_id
        WHERE b.active=1 AND b.status NOT IN ('playable','skipped') AND b.next_check_ms<=?
        ${exclusions} ORDER BY b.next_check_ms,b.attempt_id,b.file_name LIMIT ?`).all(nowMs, limit)
        .map((row) => ({ attemptId: row.attempt_id, ...canonicalRow(row), status: row.status,
          fileId: row.shoko_file_id, reason: row.reason, nextCheckMs: row.next_check_ms,
          checkedMs: row.checked_ms, createdMs: row.created_ms }));
    },
    recordBonusProgress({ attemptId, name, status, nowMs, fileId, reason, nextCheckMs = nowMs }) {
      if (!validId(attemptId) || typeof name !== 'string' || !name || !statuses.has(status) ||
          !validTime(nowMs) || !validTime(nextCheckMs) || nextCheckMs < nowMs ||
          (fileId !== undefined && !validId(fileId)) ||
          (reason !== undefined && (typeof reason !== 'string' || !reason.length || reason.length > 500))) {
        throw new TypeError('Invalid bonus progress');
      }
      return transaction(() => {
        const row = db.prepare('SELECT * FROM acquisition_bonus_files WHERE attempt_id=? AND file_name=?').get(attemptId, name);
        if (!row) return held('bonus_missing');
        if (nowMs < row.checked_ms) return held('stale_bonus_progress');
        if (row.shoko_file_id !== null && fileId !== undefined && row.shoko_file_id !== fileId) return held('file_identity_conflict');
        if (['identified', 'playable'].includes(status) && !validId(fileId)) return held('file_identity_required');
        if ((row.active === 0 || terminated(attemptId)) && status !== row.status) return held('bonus_inactive');
        const stage = ranks[status];
        if (stage !== undefined && (stage < row.progress_stage || stage > row.progress_stage + 1)) return held('invalid_bonus_transition');
        if (row.status === 'skipped' && status !== 'skipped') return held('bonus_inactive');
        const active = ['playable', 'skipped'].includes(status) ? 0 : row.active;
        db.prepare(`UPDATE acquisition_bonus_files SET status=?,active=?,shoko_file_id=?,reason=?,
          next_check_ms=?,checked_ms=?,progress_stage=? WHERE attempt_id=? AND file_name=?`)
          .run(status, active, fileId ?? row.shoko_file_id, reason ?? null,
            nextCheckMs, nowMs, stage ?? row.progress_stage, attemptId, name);
        return { state: status };
      });
    },
    deactivateBonuses(attemptId, nowMs) {
      if (!validId(attemptId) || !validTime(nowMs)) throw new TypeError('Invalid bonus deactivation');
      // One statement participates in the parent's retirement transaction, or is
      // independently atomic when called alone. Never open a nested transaction.
      const changed = db.prepare(`UPDATE acquisition_bonus_files
        SET active=0,status='skipped',reason='parent_deactivated',checked_ms=?,next_check_ms=?
        WHERE attempt_id=? AND active=1 AND NOT EXISTS (
          SELECT 1 FROM acquisition_bonus_files newer WHERE newer.attempt_id=? AND newer.checked_ms>?
        )`).run(nowMs, nowMs, attemptId, attemptId, nowMs);
      return { state: 'deactivated', changes: changed.changes };
    },
  };
}

