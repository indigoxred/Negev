// Called within the source ledger's SQLite transaction. A delayed source
// observation cannot withdraw a newer exact public-file proof.
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
    invalidateFile(fileId, observedMs) {
      fileStatement ??= prepare(`DELETE FROM file_availability_proofs
        WHERE file_id=? AND verified_ms<=?`);
      return fileStatement?.run(fileId, observedMs).changes ?? 0;
    },
    invalidateCard(libraryId, ratingKey, observedMs) {
      cardStatement ??= prepare(`DELETE FROM file_availability_proofs
        WHERE library_id=? AND rating_key=? AND verified_ms<=?`);
      return cardStatement?.run(libraryId, ratingKey, observedMs).changes ?? 0;
    },
  };
}
