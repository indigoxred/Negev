// Used invitations remain in the administrator's history after their creator
// is removed. Rebuild only the old invitation table, with FK checks enabled.
export function migrateInvitationCreators(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const creator = db.prepare('PRAGMA table_info(invitations)').all()
      .find(column => column.name === 'created_by');
    if (creator.notnull) {
      db.exec(`CREATE TABLE invitations_nullable_creator (
        id INTEGER PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE,
        created_by INTEGER REFERENCES users(id),
        expires_ms INTEGER NOT NULL CHECK(expires_ms>=0),
        used_ms INTEGER CHECK(used_ms>=0), created_ms INTEGER CHECK(created_ms>=0),
        revoked_ms INTEGER CHECK(revoked_ms>=0), used_by INTEGER REFERENCES users(id)
      ) STRICT;
      INSERT INTO invitations_nullable_creator
        SELECT i.id,i.code_hash,
          CASE WHEN EXISTS(SELECT 1 FROM users WHERE id=i.created_by) THEN i.created_by END,
          i.expires_ms,i.used_ms,i.created_ms,i.revoked_ms,
          CASE WHEN EXISTS(SELECT 1 FROM users WHERE id=i.used_by) THEN i.used_by END
        FROM invitations i;
      DROP TABLE invitations;
      ALTER TABLE invitations_nullable_creator RENAME TO invitations;`);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
