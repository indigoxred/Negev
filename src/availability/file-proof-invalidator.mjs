import { createWitnessRevisions } from './witness-revisions.mjs';
// Called inside an accepted source-change transaction. A source read may
// have started before a proof but committed after it, so accepted changes
// withdraw all proofs for that file/card regardless of read-start time.
export function createFileProofInvalidator(db) {
  if (typeof db?.prepare !== 'function') {
    throw new TypeError('Invalid file proof invalidator database');
  }
  let fileStatement;
  let cardStatement;
  let prioritizeCardFiles;
  const witnessRevisions=createWitnessRevisions(db);
  const prepare = (sql) => {
    const columns = db.prepare('PRAGMA table_info(file_availability_proofs)').all();
    if (!['file_id', 'library_id', 'rating_key', 'verified_ms'].every((name) =>
      columns.some((column) => column.name === name))) return null;
    if (columns.some(c=>c.name==='components_json') && sql.includes('WHERE file_id=?')) sql=sql.replace('WHERE file_id=?',"WHERE file_id=?1 OR (components_json IS NOT NULL AND EXISTS(SELECT 1 FROM json_each(components_json) p WHERE json_extract(p.value,'$.fileId')=?1))");
    return db.prepare(sql);
  };
  const invalidateTitle = (where, params) => {
    const columns = db.prepare('PRAGMA table_info(title_check_positive_proofs)').all();
    if (!columns.some(c => c.name === 'proof_json')) return;
    const predicate = `EXISTS(SELECT 1 FROM title_check_positive_proofs p,json_each(p.proof_json) w
      WHERE p.anidb_id=title_check_targets.anidb_id AND p.episode_id=title_check_targets.episode_id AND ${where})`;
    const affected = db.prepare(`SELECT DISTINCT anidb_id AS id FROM title_check_targets WHERE ${predicate}`).all(...params);
    db.prepare(`UPDATE title_check_targets SET state='pending',checked_ms=NULL WHERE ${predicate}`).run(...params);
    for (const {id} of affected) db.prepare(`UPDATE title_check_jobs SET state=CASE WHEN state='done' THEN 'checking' ELSE state END,
      version=version+1,lease_until_ms=0 WHERE anidb_id=?`).run(id);
    db.prepare(`DELETE FROM title_check_positive_proofs WHERE EXISTS(SELECT 1 FROM json_each(proof_json) w WHERE ${where})`).run(...params);
  };
  const invalidateDirectComponents=(where,params)=>{
    if (!db.prepare('PRAGMA table_info(direct_availability_targets)').all().some(c=>c.name==='proof_components_json')) return;
    db.prepare(`UPDATE direct_availability_targets SET state='pending',due_ms=MIN(due_ms,observed_ms),priority=1,
      version=version+1,verified_ms=NULL,proof_file_id=NULL,proof_library_id=NULL,proof_rating_key=NULL,proof_part_id=NULL,
      proof_components_json=NULL WHERE state='available' AND proof_components_json IS NOT NULL AND
      EXISTS(SELECT 1 FROM json_each(proof_components_json) w WHERE ${where})`).run(...params);
  };
  return {
    invalidateFile(fileId) {
      witnessRevisions.changeFile(fileId);
      invalidateTitle("json_extract(w.value,'$.fileId')=?",[fileId]);
      invalidateDirectComponents("json_extract(w.value,'$.fileId')=?",[fileId]);
      fileStatement ??= prepare(`DELETE FROM file_availability_proofs
        WHERE file_id=?`);
      return fileStatement?.run(fileId).changes ?? 0;
    },
    invalidateCard(libraryId, ratingKey) {
      witnessRevisions.changeCard(libraryId,ratingKey);
      invalidateTitle("json_extract(w.value,'$.libraryId')=? AND json_extract(w.value,'$.ratingKey')=?",[libraryId,ratingKey]);
      invalidateDirectComponents("json_extract(w.value,'$.libraryId')=? AND json_extract(w.value,'$.ratingKey')=?",[libraryId,ratingKey]);
      cardStatement ??= prepare(`DELETE FROM file_availability_proofs
        WHERE library_id=? AND rating_key=?`);
      // Recheck only files whose exact public proof this card is retiring.
      // The existing backfill worker still enforces its per-tick read budget.
      if (cardStatement && !prioritizeCardFiles) {
        const columns = db.prepare('PRAGMA table_info(file_backfill_priority)').all();
        if (columns.some((column) => column.name === 'rank')) {
          prioritizeCardFiles = db.prepare(`INSERT INTO file_backfill_priority
            (file_id,rank) SELECT DISTINCT file_id,1 FROM file_availability_proofs
            WHERE library_id=? AND rating_key=?
            ON CONFLICT(file_id) DO UPDATE SET rank=1 WHERE rank=0`);
        }
      }
      prioritizeCardFiles?.run(libraryId, ratingKey);
      return cardStatement?.run(libraryId, ratingKey).changes ?? 0;
    },
  };
}
