// Called inside an accepted source-change transaction. A source read may
// have started before a proof but committed after it, so accepted changes
// withdraw all proofs for that file/card regardless of read-start time.
export function createFileProofInvalidator(db) {
  if (typeof db?.prepare !== 'function') {
    throw new TypeError('Invalid file proof invalidator database');
  }
  let fileStatement;
  let cardStatement;
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
      return cardStatement?.run(libraryId, ratingKey).changes ?? 0;
    },
  };
}
