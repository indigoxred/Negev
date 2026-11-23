// One bounded row per observed source identity. Accepted source mutations call
// these methods inside their existing transaction, including event-only file
// invalidations that do not append a full inventory change record.
export function createWitnessRevisions(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS availability_witness_clock (
    id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL) STRICT;
    INSERT OR IGNORE INTO availability_witness_clock VALUES(1,0);
    CREATE TABLE IF NOT EXISTS availability_witness_revisions (
      kind TEXT NOT NULL CHECK(kind IN ('file','card')),
      source_id INTEGER NOT NULL,card_id INTEGER NOT NULL,version INTEGER NOT NULL,
      PRIMARY KEY(kind,source_id,card_id)) STRICT`);
  const current=db.prepare('SELECT version FROM availability_witness_clock WHERE id=1');
  const change=(kind,id,cardId)=>{
    db.exec('UPDATE availability_witness_clock SET version=version+1 WHERE id=1');
    db.prepare(`INSERT INTO availability_witness_revisions VALUES(?,?,?,?)
      ON CONFLICT(kind,source_id,card_id) DO UPDATE SET version=excluded.version`).run(kind,id,cardId,current.get().version);
  };
  const changed=db.prepare(`SELECT 1 FROM availability_witness_revisions WHERE version>?
    AND ((kind='file' AND source_id=?) OR (kind='card' AND source_id=? AND card_id=?)) LIMIT 1`);
  return {version:()=>current.get().version,
    changeFile:id=>change('file',id,0),
    changeCard:(libraryId,ratingKey)=>change('card',libraryId,ratingKey),
    changed:(part,version)=>!!changed.get(version,part.fileId,part.libraryId,part.ratingKey)};
}
