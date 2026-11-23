import { DatabaseSync } from 'node:sqlite';
import { compositeComponents, pruneCompositeProofs } from './multipart-proof-components.mjs';

const validId = (value) => Number.isSafeInteger(value) && value > 0;
const validTime = (value) => Number.isSafeInteger(value) && value >= 0;
const held = () => ({ state: 'held', reason: 'invalid_exact_proof' });

// Positive evidence from the internal exact Shoko/public Plex same-file
// observer. A stale proof is retained as history, never presented as current.
export function openFileProofLedger(dbPath, { positiveLifetimeMs,
  now = Date.now, discardPriorProofs = false, evidenceTrusted = () => true } = {}) {
  if (typeof dbPath !== 'string' || !dbPath || dbPath === ':memory:' ||
      !Number.isSafeInteger(positiveLifetimeMs) ||
      positiveLifetimeMs < 1 || positiveLifetimeMs > 7 * 24 * 60 * 60_000 ||
      typeof now !== 'function' || typeof discardPriorProofs !== 'boolean' || typeof evidenceTrusted !== 'function') {
    throw new TypeError('Invalid file proof ledger configuration');
  }
  const db = new DatabaseSync(dbPath, { timeout: 5_000 });
  try {
    db.exec('PRAGMA journal_mode=WAL');
    db.exec(`CREATE TABLE IF NOT EXISTS file_availability_proofs (
      anidb_id INTEGER NOT NULL CHECK(anidb_id>0),
      episode_id INTEGER NOT NULL CHECK(episode_id>0),
      file_id INTEGER NOT NULL CHECK(file_id>0),
      library_id INTEGER NOT NULL CHECK(library_id>0),
      rating_key INTEGER NOT NULL CHECK(rating_key>0),
      part_id INTEGER NOT NULL CHECK(part_id>0),
      verified_ms INTEGER NOT NULL CHECK(verified_ms>=0),
      presentation TEXT NOT NULL DEFAULT 'exact'
        CHECK(presentation IN ('exact','alternate_card')),
      PRIMARY KEY(anidb_id,episode_id,file_id,library_id,rating_key,part_id)
    ) STRICT`);
    if (!db.prepare('PRAGMA table_info(file_availability_proofs)').all()
      .some((column) => column.name === 'presentation')) {
      db.exec(`ALTER TABLE file_availability_proofs ADD COLUMN presentation
        TEXT NOT NULL DEFAULT 'exact'
        CHECK(presentation IN ('exact','alternate_card'))`);
    }
    if (!db.prepare('PRAGMA table_info(file_availability_proofs)').all().some(c=>c.name==='components_json')) {
      db.exec('ALTER TABLE file_availability_proofs ADD COLUMN components_json TEXT');
      // v300 could not retain all witnesses. Retire only legacy scalar cache
      // rows whose indexed Part belongs to an explicitly multipart Media.
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='plex_card_observations'").get()) db.exec(
        `DELETE FROM file_availability_proofs AS f WHERE EXISTS(SELECT 1 FROM plex_card_observations c,json_each(CASE WHEN json_valid(c.identity_signature) THEN c.identity_signature ELSE '[]' END,'$[1]') p
        WHERE c.library_id=f.library_id AND c.rating_key=f.rating_key AND json_extract(p.value,'$[0]')=f.part_id AND json_extract(p.value,'$[9]')>1)`);
    }
    db.exec('CREATE INDEX IF NOT EXISTS file_proof_components ON file_availability_proofs(anidb_id,episode_id) WHERE components_json IS NOT NULL');
    db.exec(`CREATE INDEX IF NOT EXISTS file_proof_episode
      ON file_availability_proofs(anidb_id,episode_id,verified_ms DESC)`);
    db.exec(`CREATE INDEX IF NOT EXISTS file_proof_file
      ON file_availability_proofs(file_id,verified_ms)`);
    db.exec(`CREATE INDEX IF NOT EXISTS file_proof_card
      ON file_availability_proofs(library_id,rating_key,verified_ms)`);
    // Saved positives remain current until their configured lifetime expires.
    // Accepted Shoko/Plex changes invalidate them, but changes while Negev is
    // stopped may remain visible until the resumed source sweep observes them.
    // An explicit discard is available for a recovery that cannot trust the
    // saved source generation.
    if (discardPriorProofs) db.exec('DELETE FROM file_availability_proofs');
  } catch (error) { db.close(); throw error; }
  const upsert = db.prepare(`INSERT INTO file_availability_proofs
    (anidb_id,episode_id,file_id,library_id,rating_key,part_id,verified_ms,presentation,components_json)
    VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT DO UPDATE SET
      verified_ms=excluded.verified_ms,
      presentation=excluded.presentation,components_json=excluded.components_json
    WHERE excluded.verified_ms>=file_availability_proofs.verified_ms`);
  const current = db.prepare(`SELECT verified_ms AS verifiedMs,presentation
    FROM file_availability_proofs WHERE anidb_id=? AND episode_id=?
      AND verified_ms<=?
    ORDER BY (verified_ms>? AND presentation='exact') DESC,
      verified_ms DESC LIMIT 1`);
  const positiveForAnime = db.prepare(`SELECT DISTINCT episode_id AS episodeId
    FROM file_availability_proofs WHERE anidb_id=? AND verified_ms>?
      AND verified_ms<=? ORDER BY episode_id LIMIT 10001`);
  const currentTitles = db.prepare(`SELECT anidb_id AS anidbId,
      COUNT(DISTINCT episode_id) AS verifiedEpisodeCount,
      MAX(verified_ms) AS lastVerifiedMs
    FROM file_availability_proofs
    WHERE anidb_id>? AND verified_ms>? AND verified_ms<=?
    GROUP BY anidb_id ORDER BY anidb_id LIMIT ?`);
  const currentTitleCard = db.prepare(`SELECT library_id AS libraryId,
      rating_key AS ratingKey
    FROM file_availability_proofs
    WHERE anidb_id=? AND verified_ms>? AND verified_ms<=?
    ORDER BY (presentation='exact') DESC,verified_ms DESC,
      library_id,rating_key LIMIT 1`);
  let sourceStillCurrent;
  const prune = (anidbId=null,episodeId=null) => pruneCompositeProofs(db,anidbId,episodeId);
  return {
    observe({ anidbId, episodeId, proof, checkedMs } = {}) {
      const observedNow = now();
      if (!validId(anidbId) || !validId(episodeId) ||
          !validId(proof?.fileId) || !validId(proof.libraryId) ||
          !validId(proof.ratingKey) || !validId(proof.partId) ||
          !validTime(checkedMs) || !validTime(observedNow) ||
          checkedMs > observedNow ||
          (![undefined, 'alternate_card'].includes(proof.presentation) || proof.parts !== undefined)) return held();
      const identity = [anidbId, episodeId, proof.fileId,
        proof.libraryId, proof.ratingKey, proof.partId];
      const saved = upsert.run(...identity, checkedMs,
        proof.presentation ?? 'exact',null);
      return { state: saved.changes === 1 ? 'recorded' : 'stale' };
    },
    observeGuarded({ anidbId, episodeId, proof, revision,
      checkedMs } = {}) {
      const observedNow = now();
      const storageKey = proof?.storageKey;
      const source = revision?.source;
      const card = revision?.card;
      if (!validId(anidbId) || !validId(episodeId) ||
          !validId(proof?.fileId) || !validId(proof.libraryId) ||
          !validId(proof.ratingKey) || !validId(proof.partId) ||
          typeof storageKey !== 'string' || storageKey.length > 128 ||
          !/^(0|[1-9]\d{0,30}):[1-9]\d{0,30}:[1-9]\d{0,15}$/.test(storageKey) ||
          typeof source?.updated !== 'string' ||
          !Number.isFinite(Date.parse(source.updated)) ||
          !validTime(source.observedMs) ||
          typeof card?.identitySignature !== 'string' ||
          card.identitySignature.length < 1 ||
          card.identitySignature.length > 100_000 ||
          !validTime(card.observedMs) || !validTime(checkedMs) ||
          !validTime(observedNow) || checkedMs > observedNow ||
          source.observedMs > checkedMs || card.observedMs > checkedMs ||
          ![undefined, 'alternate_card'].includes(proof.presentation)) {
        return held();
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        const sources = db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
          WHERE type='table' AND name IN ('shoko_inventory_files',
            'shoko_inventory_pairs','plex_card_observations',
            'plex_part_candidates')`).get();
        if (sources.count !== 4) {
          db.exec('ROLLBACK');
          return { state: 'held', reason: 'source_generation_changed' };
        }
        sourceStillCurrent ??= db.prepare(`SELECT 1 AS current
          FROM shoko_inventory_files f
          JOIN shoko_inventory_pairs e ON e.file_id=f.file_id
          JOIN plex_card_observations c ON c.library_id=?
            AND c.rating_key=?
          JOIN plex_part_candidates p ON p.library_id=c.library_id
            AND p.rating_key=c.rating_key
          WHERE f.file_id=? AND f.state='linked' AND f.updated=?
            AND f.observed_ms=? AND e.anidb_id=? AND e.episode_id=?
            AND c.observed_ms=? AND c.identity_signature=?
            AND p.part_id=? AND p.candidate_key=? LIMIT 1`);
        const components = compositeComponents(proof,revision,checkedMs);
        if (proof.parts !== undefined && !components) { db.exec('ROLLBACK'); return held(); }
        if (components && components.some(part=>!sourceStillCurrent.get(part.libraryId,part.ratingKey,part.fileId,part.sourceUpdated,part.sourceObservedMs,anidbId,episodeId,card.observedMs,card.identitySignature,part.partId,part.storageKey))) {
          db.exec('ROLLBACK'); return {state:'held',reason:'source_generation_changed'};
        }
        const currentSource = sourceStillCurrent.get(proof.libraryId,
          proof.ratingKey, proof.fileId, source.updated, source.observedMs,
          anidbId, episodeId, card.observedMs, card.identitySignature,
          proof.partId, storageKey);
        if (!currentSource) {
          db.exec('ROLLBACK');
          return { state: 'held', reason: 'source_generation_changed' };
        }
        const saved = upsert.run(anidbId, episodeId, proof.fileId,
          proof.libraryId, proof.ratingKey, proof.partId, checkedMs,
          proof.presentation ?? 'exact',components ? JSON.stringify(components) : null);
        db.exec('COMMIT');
        return { state: saved.changes === 1 ? 'recorded' : 'stale' };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    getCurrent({ anidbId, episodeId } = {}) {
      if (!validId(anidbId) || !validId(episodeId)) {
        throw new TypeError('Invalid file proof target');
      }
      if (!evidenceTrusted()) return {state:'unknown'};
      const nowMs = now();
      if (!validTime(nowMs)) throw new TypeError('Invalid file proof clock');
      prune(anidbId,episodeId);
      const row = current.get(anidbId, episodeId, nowMs,
        nowMs - positiveLifetimeMs);
      if (!validTime(row?.verifiedMs)) return { state: 'unknown' };
      return { state: row.verifiedMs + positiveLifetimeMs > nowMs
        ? 'available' : 'previously_available',
      verifiedAtMs: row.verifiedMs,
      ...(row.presentation === 'alternate_card'
        ? { presentation: 'alternate_card' } : {}) };
    },
    getRecentAvailableIds({ anidbId } = {}) {
      if (!validId(anidbId)) throw new TypeError('Invalid file proof anime');
      if (!evidenceTrusted()) return [];
      const nowMs = now();
      if (!validTime(nowMs)) throw new TypeError('Invalid file proof clock');
      prune(anidbId);
      const rows = positiveForAnime.all(anidbId,
        nowMs - positiveLifetimeMs, nowMs);
      return rows.length > 10_000 ? [] : rows.map((row) => row.episodeId);
    },
    getCurrentTitleCard({ anidbId } = {}) {
      if (!validId(anidbId)) throw new TypeError('Invalid file proof anime');
      if (!evidenceTrusted()) return null;
      const nowMs = now();
      if (!validTime(nowMs)) throw new TypeError('Invalid file proof clock');
      prune(anidbId);
      const card = currentTitleCard.get(anidbId,
        nowMs - positiveLifetimeMs, nowMs);
      return card ? { libraryId: card.libraryId,
        ratingKey: card.ratingKey } : null;
    },
    listCurrentTitles({ afterAnidbId = 0, limit = 20 } = {}) {
      if (!evidenceTrusted()) return {items:[],nextAfterAnidbId:null};
      const nowMs = now();
      if (!Number.isSafeInteger(afterAnidbId) || afterAnidbId < 0 ||
          !Number.isSafeInteger(limit) || limit < 1 || limit > 50 ||
          !validTime(nowMs)) throw new TypeError('Invalid library browse page');
      prune();
      const rows = currentTitles.all(afterAnidbId,
        nowMs - positiveLifetimeMs, nowMs, limit + 1);
      const items = rows.slice(0, limit).map(({ anidbId,
        verifiedEpisodeCount, lastVerifiedMs }) =>
        ({ anidbId, verifiedEpisodeCount, lastVerifiedMs }));
      return { items, nextAfterAnidbId: rows.length > limit
        ? items.at(-1).anidbId : null };
    },
    close() { db.close(); },
  };
}
