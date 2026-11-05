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
  const prepare = (sql) => {
    const columns = db.prepare('PRAGMA table_info(file_availability_proofs)').all();
    if (!['file_id', 'library_id', 'rating_key', 'verified_ms'].every((name) =>
      columns.some((column) => column.name === name))) return null;
    return db.prepare(sql);
  };
  return {
    invalidateFile(fileId) {
      fileStatement ??= prepare(`DELETE FROM file_availability_proofs
        WHERE file_id=?`);
      return fileStatement?.run(fileId).changes ?? 0;
    },
    invalidateCard(libraryId, ratingKey) {
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
