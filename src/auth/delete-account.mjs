import { DatabaseSync } from 'node:sqlite';

const held = (reason) => ({ state: 'held', reason });
const validId = (id) => Number.isSafeInteger(id) && id > 0;

// Tables keyed by request_id that only exist once their module has opened.
// Rows for a request that never started a download are removed with it.
const REQUEST_CHILD_TABLES = ['request_targets', 'rss_watch_timing',
  'acquisition_request_checks', 'acquisition_request_suspensions',
  'preferred_release_waits', 'acquisition_quality_retry', 'rss_release_wakes'];

// Permanently removes a disabled account and its requests, in one
// transaction. A request that already started a download keeps its record,
// because that record describes files already in Plex or still downloading;
// it stops watching for new episodes so nothing more is fetched for it.
// Foreign keys are left off on this connection: invitations the account
// created stay listed, without a creator name.
export function deleteAccount(dbPath, { adminUserId, userId }) {
  if (typeof dbPath !== 'string' || !dbPath || !validId(adminUserId) || !validId(userId)) {
    throw new TypeError('Invalid account deletion');
  }
  const db = new DatabaseSync(dbPath, { timeout: 5_000 });
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all().map((row) => row.name));
    const has = (name) => tables.has(name);
    db.exec('BEGIN IMMEDIATE');
    try {
      const findUser = db.prepare('SELECT id,username,role,disabled FROM users WHERE id=?');
      const admin = findUser.get(adminUserId);
      if (!admin || admin.role !== 'admin' || admin.disabled) {
        db.exec('ROLLBACK');
        return held('admin_required');
      }
      if (userId === adminUserId) { db.exec('ROLLBACK'); return held('cannot_delete_self'); }
      const user = findUser.get(userId);
      if (!user) { db.exec('ROLLBACK'); return held('user_unavailable'); }
      if (!user.disabled) { db.exec('ROLLBACK'); return held('disable_first'); }

      const requestIds = has('requests')
        ? db.prepare('SELECT id FROM requests WHERE requester_id=?').all(userId).map((row) => row.id)
        : [];
      const startedIds = new Set(has('acquisition_attempts') && requestIds.length
        ? db.prepare(`SELECT DISTINCT request_id FROM acquisition_attempts
          WHERE request_id IN (SELECT id FROM requests WHERE requester_id=?)`).all(userId)
          .map((row) => row.request_id)
        : []);
      const removable = requestIds.filter((id) => !startedIds.has(id));
      const childDeletes = REQUEST_CHILD_TABLES.filter(has)
        .map((table) => db.prepare(`DELETE FROM ${table} WHERE request_id=?`));
      const clearInstallment = has('parent_watch_installments')
        ? db.prepare('UPDATE parent_watch_installments SET request_id=NULL WHERE request_id=?') : null;
      const deleteRequest = db.prepare('DELETE FROM requests WHERE id=?');
      for (const requestId of removable) {
        for (const statement of childDeletes) statement.run(requestId);
        clearInstallment?.run(requestId);
        deleteRequest.run(requestId);
      }
      if (startedIds.size) {
        db.prepare('UPDATE requests SET watch_closed=1 WHERE requester_id=? AND watch_closed=0')
          .run(userId);
      }
      if (has('pending_title_intents')) {
        db.prepare('DELETE FROM pending_title_intents WHERE requester_id=?').run(userId);
      }
      if (has('parent_watches')) {
        const watches = db.prepare('SELECT tvdb_id FROM parent_watches WHERE requester_id=?')
          .all(userId).map((row) => row.tvdb_id);
        for (const table of ['parent_watch_installments', 'parent_watch_frontiers',
          'parent_watch_relation_evidence'].filter(has)) {
          const statement = db.prepare(`DELETE FROM ${table} WHERE tvdb_id=?`);
          for (const tvdbId of watches) statement.run(tvdbId);
        }
        db.prepare('DELETE FROM parent_watches WHERE requester_id=?').run(userId);
      }
      for (const [table, sql] of [
        ['user_sessions', 'DELETE FROM user_sessions WHERE user_id=?'],
        ['airing_preferences', 'DELETE FROM airing_preferences WHERE user_id=?'],
        ['password_resets', 'DELETE FROM password_resets WHERE user_id=?1 OR created_by=?1'],
      ]) if (has(table)) db.prepare(sql).run(userId);
      if (has('invitations')) {
        const columns = new Set(db.prepare('PRAGMA table_info(invitations)').all().map((c) => c.name));
        if (columns.has('used_by')) {
          db.prepare('UPDATE invitations SET used_by=NULL WHERE used_by=?').run(userId);
        }
        // Unused invitations from a removed admin no longer have an owner.
        db.prepare(`DELETE FROM invitations WHERE created_by=? AND used_ms IS NULL`).run(userId);
      }
      db.prepare('DELETE FROM users WHERE id=?').run(userId);
      db.exec('COMMIT');
      return { state: 'deleted', userId, username: user.username,
        deletedRequests: removable.length, keptStartedRequests: startedIds.size };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* Already rolled back. */ }
      throw error;
    }
  } finally { db.close(); }
}
