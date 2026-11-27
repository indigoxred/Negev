import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { allocateDurableId } from '../runtime/durable-id.mjs';
import { migrateInvitationCreators } from './invitation-schema.mjs';

const scrypt = promisify(scryptCallback);
const held = (reason) => ({ state: 'held', reason });
const validId = (id) => Number.isSafeInteger(id) && id > 0;
const validTime = (time) => Number.isSafeInteger(time) && time >= 0;
const usernameKey = (name) => name.toLowerCase();
const validUsername = (name) => typeof name === 'string' &&
  /^[A-Za-z][A-Za-z0-9_]{2,31}$/.test(name);
const validPassword = (value) => typeof value === 'string' &&
  Buffer.byteLength(value, 'utf8') >= 12 && Buffer.byteLength(value, 'utf8') <= 128 &&
  !/[\x00-\x1f\x7f]/.test(value);
const digest = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
// A signed-in device stays signed in while it is used at least once every
// SESSION_IDLE_MS, and never longer than SESSION_MAX_MS after sign-in.
export const SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_MAX_MS = 30 * 24 * 60 * 60 * 1000;
// Activity is written at most this often, not on every request.
const SESSION_TOUCH_MS = 5 * 60 * 1000;
const validSessionId = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function invitedAccountValidation({ code, username, password } = {}) {
  if (typeof code !== 'string' || !/^[a-f0-9]{64}$/.test(code)) return {
    field: 'code', error: 'Enter the complete 64-character invitation code supplied by the owner.' };
  if (!validUsername(username)) return { field: 'username',
    error: 'Username must be 3–32 characters, start with a letter, and use only letters, numbers or underscores.' };
  if (!validPassword(password)) return { field: 'password',
    error: 'Password must be 12–128 UTF-8 bytes and cannot contain tabs, line breaks or other control characters.' };
  return null;
}
async function hashPassword(password, salt) {
  return (await scrypt(password, Buffer.from(salt, 'hex'), 32,
    { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })).toString('hex');
}

// The application opens this ledger from its private persistent data volume.
// Passwords and invitation tokens are never stored in plaintext.
export function openAccountLedger(dbPath, { now = Date.now } = {}) {
  if (typeof dbPath !== 'string' || !dbPath || dbPath === ':memory:' ||
      typeof now !== 'function') throw new TypeError('A durable account database is required');
  const db = new DatabaseSync(dbPath, { timeout: 5_000 });
  try {
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA foreign_keys=ON');
    db.exec(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL,
      username_key TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL CHECK(role IN ('admin','member')),
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 1 CHECK(session_version>0),
      disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1)),
      adult_allowed INTEGER NOT NULL DEFAULT 1 CHECK(adult_allowed IN (0,1)),
      created_ms INTEGER NOT NULL CHECK(created_ms>=0)
    ) STRICT`);
    if (!db.prepare('PRAGMA table_info(users)').all()
      .some((column) => column.name === 'adult_allowed')) {
      db.exec('ALTER TABLE users ADD COLUMN adult_allowed INTEGER NOT NULL DEFAULT 1 CHECK(adult_allowed IN (0,1))');
    }
    db.exec(`CREATE TABLE IF NOT EXISTS invitations (
      id INTEGER PRIMARY KEY,
      code_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id),
      expires_ms INTEGER NOT NULL CHECK(expires_ms>=0),
      used_ms INTEGER CHECK(used_ms>=0)
    ) STRICT`);
    db.exec(`CREATE TABLE IF NOT EXISTS airing_preferences (
      user_id INTEGER PRIMARY KEY REFERENCES users(id),
      mode TEXT NOT NULL CHECK(mode IN ('library','all','custom')),
      tracked_ids TEXT NOT NULL
    ) STRICT`);
    // One row per signed-in device. Signing out deletes only that row;
    // "sign out everywhere" also bumps users.session_version. Earlier builds
    // ignore this table, so it is safe to roll back.
    db.exec(`CREATE TABLE IF NOT EXISTS user_sessions (
      id_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      created_ms INTEGER NOT NULL CHECK(created_ms>=0),
      last_seen_ms INTEGER NOT NULL CHECK(last_seen_ms>=0)
    ) STRICT`);
    db.exec('CREATE INDEX IF NOT EXISTS user_sessions_user ON user_sessions(user_id)');
    // Invitation bookkeeping for the admin list. Nullable, so earlier builds
    // keep working on the same database.
    const inviteColumns = new Set(db.prepare('PRAGMA table_info(invitations)').all()
      .map((column) => column.name));
    for (const [name, type] of [['created_ms', 'INTEGER CHECK(created_ms>=0)'],
      ['revoked_ms', 'INTEGER CHECK(revoked_ms>=0)'],
      ['used_by', 'INTEGER REFERENCES users(id)']]) {
      if (!inviteColumns.has(name)) db.exec(`ALTER TABLE invitations ADD COLUMN ${name} ${type}`);
    }
    migrateInvitationCreators(db);
    // One-time password reset links an admin hands to a user. Only the
    // code's digest is stored; using one ends every session for the account.
    db.exec(`CREATE TABLE IF NOT EXISTS password_resets (
      id INTEGER PRIMARY KEY,
      code_hash TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_ms INTEGER NOT NULL CHECK(created_ms>=0),
      expires_ms INTEGER NOT NULL CHECK(expires_ms>=0),
      used_ms INTEGER CHECK(used_ms>=0)
    ) STRICT`);
    db.exec('PRAGMA foreign_keys=ON');
  } catch (error) { db.close(); throw error; }
  const countUsers = db.prepare('SELECT COUNT(*) AS count FROM users');
  const insertUser = db.prepare(`INSERT INTO users
    (id,username,username_key,role,password_salt,password_hash,created_ms)
    VALUES (?,?,?,?,?,?,?)`);
  const findName = db.prepare('SELECT id FROM users WHERE username_key=?');
  const findAuth = db.prepare(`SELECT id,username,role,password_salt,password_hash,
    session_version,disabled,adult_allowed FROM users WHERE username_key=?`);
  const findUser = db.prepare(`SELECT id,username,role,session_version,disabled,adult_allowed
    FROM users WHERE id=?`);
  const listAccounts = db.prepare(`SELECT id,username,role,disabled,adult_allowed
    FROM users ORDER BY id`);
  const updateAdult = db.prepare(`UPDATE users SET adult_allowed=? WHERE id=? AND disabled=0`);
  const updateDisabled = db.prepare('UPDATE users SET disabled=? WHERE id=?');
  const findAiring = db.prepare('SELECT mode,tracked_ids FROM airing_preferences WHERE user_id=?');
  const saveAiring = db.prepare(`INSERT INTO airing_preferences
    (user_id,mode,tracked_ids) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET
    mode=excluded.mode,tracked_ids=excluded.tracked_ids`);
  const insertInvite = db.prepare(`INSERT INTO invitations
    (code_hash,created_by,expires_ms,created_ms) VALUES (?,?,?,?)`);
  const findInvite = db.prepare(`SELECT id,expires_ms,used_ms,revoked_ms
    FROM invitations WHERE code_hash=?`);
  const useInvite = db.prepare(`UPDATE invitations SET used_ms=?,used_by=?
    WHERE id=? AND used_ms IS NULL AND revoked_ms IS NULL`);
  const inviteUsable = (invite, at) => invite && invite.used_ms === null &&
    invite.revoked_ms === null && invite.expires_ms > at;
  const listInviteRows = db.prepare(`SELECT i.id,i.created_ms,i.expires_ms,i.used_ms,
    i.revoked_ms,c.username AS created_by_name,u.username AS used_by_name
    FROM invitations i LEFT JOIN users c ON c.id=i.created_by
    LEFT JOIN users u ON u.id=i.used_by ORDER BY i.id DESC LIMIT ?`);
  const revokeInviteRow = db.prepare(`UPDATE invitations SET revoked_ms=?
    WHERE id=? AND used_ms IS NULL AND revoked_ms IS NULL`);
  const insertReset = db.prepare(`INSERT INTO password_resets
    (code_hash,user_id,created_by,created_ms,expires_ms) VALUES (?,?,?,?,?)`);
  const dropOpenResets = db.prepare(`DELETE FROM password_resets
    WHERE user_id=? AND used_ms IS NULL`);
  const findReset = db.prepare(`SELECT id,user_id,expires_ms,used_ms
    FROM password_resets WHERE code_hash=?`);
  const useReset = db.prepare(`UPDATE password_resets SET used_ms=?
    WHERE id=? AND used_ms IS NULL`);
  const updatePassword = db.prepare(`UPDATE users SET password_salt=?,password_hash=?,
    session_version=session_version+1 WHERE id=?`);
  const bumpVersion = db.prepare(`UPDATE users SET session_version=session_version+1
    WHERE id=? AND disabled=0`);
  const insertSession = db.prepare(`INSERT INTO user_sessions
    (id_hash,user_id,created_ms,last_seen_ms) VALUES (?,?,?,?)`);
  const findSession = db.prepare(`SELECT user_id,created_ms,last_seen_ms
    FROM user_sessions WHERE id_hash=?`);
  const touchSession = db.prepare('UPDATE user_sessions SET last_seen_ms=? WHERE id_hash=?');
  const deleteSession = db.prepare('DELETE FROM user_sessions WHERE id_hash=?');
  const deleteUserSessions = db.prepare('DELETE FROM user_sessions WHERE user_id=?');
  const pruneSessions = db.prepare(`DELETE FROM user_sessions
    WHERE last_seen_ms<? OR created_ms<?`);
  const sessionExpired = (row, at) => at - row.last_seen_ms > SESSION_IDLE_MS ||
    at - row.created_ms > SESSION_MAX_MS;
  const publicUser = (row) => ({ id: row.id, username: row.username,
    role: row.role, sessionVersion: row.session_version,
    adultAllowed: row.adult_allowed === 1 });
  // An internet-facing login can receive requests from many source IPs.
  // Bound simultaneous memory-intensive scrypt work across sign-in and
  // invited registration, independent of per-IP HTTP rate limits.
  let activePasswordChecks = 0;
  const boundedPasswordHash = async (password, salt) => {
    if (activePasswordChecks >= 2) return null;
    activePasswordChecks++;
    try { return await hashPassword(password, salt); }
    finally { activePasswordChecks--; }
  };
  function transact(action) {
    let begun = false;
    try {
      db.exec('BEGIN IMMEDIATE');
      begun = true;
      const result = action();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      if (begun) db.exec('ROLLBACK');
      throw error;
    }
  }
  return {
    getAiringPreferences({ userId }) {
      if (!validId(userId)) throw new TypeError('Invalid user ID');
      const user = findUser.get(userId);
      if (!user || user.disabled) return null;
      const row = findAiring.get(userId);
      return row ? { mode: row.mode, trackedAnidbIds: JSON.parse(row.tracked_ids) }
        : { mode: 'library', trackedAnidbIds: [] };
    },
    setAiringPreferences({ userId, mode, trackedAnidbIds }) {
      if (!validId(userId) || !['library', 'all', 'custom'].includes(mode) ||
          !Array.isArray(trackedAnidbIds) || trackedAnidbIds.length > 200 ||
          trackedAnidbIds.some((id) => !validId(id) || id > 2_147_483_647)) {
        throw new TypeError('Invalid Airing preferences');
      }
      const normalized = [...new Set(trackedAnidbIds)].sort((a, b) => a - b);
      return transact(() => {
        const user = findUser.get(userId);
        if (!user || user.disabled) return null;
        saveAiring.run(userId, mode, JSON.stringify(normalized));
        return { mode, trackedAnidbIds: normalized };
      });
    },
    // Apply one intent against the current row under the write lock. A mode
    // change never replaces another tab's tracked list (or automatic tracking).
    changeAiringPreferences({ userId, action, mode, anidbId, sessionVersion }) {
      if (!validId(userId) || !['mode', 'track', 'untrack'].includes(action) ||
          (sessionVersion !== undefined && !validId(sessionVersion)) ||
          (action === 'mode' ? !['library', 'all', 'custom'].includes(mode) ||
            anidbId !== undefined : !validId(anidbId) || anidbId > 2_147_483_647 ||
            mode !== undefined)) throw new TypeError('Invalid Airing preference intent');
      return transact(() => {
        const user = findUser.get(userId);
        if (!user || user.disabled || sessionVersion !== undefined &&
            user.session_version !== sessionVersion) return null;
        const row = findAiring.get(userId);
        const ids = new Set(row ? JSON.parse(row.tracked_ids) : []);
        if (action === 'track' && !ids.has(anidbId) && ids.size >= 200)
          return held('tracking_limit');
        if (action === 'track') ids.add(anidbId);
        if (action === 'untrack') ids.delete(anidbId);
        const nextMode = action === 'mode' ? mode : row?.mode ?? 'library';
        const trackedAnidbIds = [...ids].sort((a, b) => a - b);
        saveAiring.run(userId, nextMode, JSON.stringify(trackedAnidbIds));
        return { mode: nextMode, trackedAnidbIds };
      });
    },
    async bootstrapAdmin({ username, password }) {
      if (!validUsername(username) || !validPassword(password)) {
        throw new TypeError('Invalid admin credentials');
      }
      if (countUsers.get().count !== 0) return null;
      const salt = randomBytes(16).toString('hex');
      const passwordHash = await hashPassword(password, salt);
      return transact(() => {
        if (countUsers.get().count !== 0) return null;
        const id = Number(insertUser.run(allocateDurableId(db, 'users'), username, usernameKey(username), 'admin',
          salt, passwordHash, now()).lastInsertRowid);
        return publicUser(findUser.get(id));
      });
    },
    createInvite({ adminUserId, expiresMs }) {
      if (!validId(adminUserId) || !validTime(expiresMs) ||
          expiresMs <= now() || expiresMs > now() + 30 * 24 * 60 * 60 * 1000) {
        throw new TypeError('Invalid invitation');
      }
      const admin = findUser.get(adminUserId);
      if (!admin || admin.role !== 'admin' || admin.disabled) return held('admin_required');
      const code = randomBytes(32).toString('hex');
      const id = Number(insertInvite.run(digest(code), adminUserId, expiresMs, now()).lastInsertRowid);
      return { state: 'created', id, code, expiresMs };
    },
    // The 50 most recent invitations. Codes are never stored, so a lost
    // invite cannot be shown again; revoke it and create a new one.
    listInvites({ adminUserId }) {
      if (!validId(adminUserId)) throw new TypeError('Invalid admin ID');
      const admin = findUser.get(adminUserId);
      if (!admin || admin.role !== 'admin' || admin.disabled) return held('admin_required');
      const at = now();
      return { state: 'invitations', items: listInviteRows.all(50).map((row) => ({
        id: row.id,
        status: row.revoked_ms !== null ? 'revoked' : row.used_ms !== null ? 'used'
          : row.expires_ms <= at ? 'expired' : 'active',
        createdMs: row.created_ms, expiresMs: row.expires_ms,
        usedMs: row.used_ms, revokedMs: row.revoked_ms,
        createdBy: row.created_by_name ?? null, usedBy: row.used_by_name ?? null,
      })) };
    },
    revokeInvite({ adminUserId, inviteId }) {
      if (!validId(adminUserId) || !validId(inviteId)) throw new TypeError('Invalid invitation');
      return transact(() => {
        const admin = findUser.get(adminUserId);
        if (!admin || admin.role !== 'admin' || admin.disabled) return held('admin_required');
        if (revokeInviteRow.run(now(), inviteId).changes !== 1) return held('invite_unavailable');
        return { state: 'revoked', id: inviteId };
      });
    },
    // A new link replaces any unused one for the same account.
    createPasswordReset({ adminUserId, userId, expiresMs }) {
      if (!validId(adminUserId) || !validId(userId) || !validTime(expiresMs) ||
          expiresMs <= now() || expiresMs > now() + 7 * 24 * 60 * 60 * 1000) {
        throw new TypeError('Invalid password reset');
      }
      return transact(() => {
        const admin = findUser.get(adminUserId);
        if (!admin || admin.role !== 'admin' || admin.disabled) return held('admin_required');
        const user = findUser.get(userId);
        if (!user) return held('user_unavailable');
        dropOpenResets.run(userId);
        const code = randomBytes(32).toString('hex');
        insertReset.run(digest(code), userId, adminUserId, now(), expiresMs);
        return { state: 'created', userId, username: user.username, code, expiresMs };
      });
    },
    // Sets a new password from a reset code and signs the account out on
    // every device. A disabled account stays disabled.
    async resetPassword({ code, password }) {
      if (typeof code !== 'string' || !/^[a-f0-9]{64}$/.test(code) || !validPassword(password)) {
        throw new TypeError('Invalid password reset');
      }
      const codeHash = digest(code);
      const usable = (row) => row && row.used_ms === null && row.expires_ms > now();
      if (!usable(findReset.get(codeHash))) return held('reset_unavailable');
      const salt = randomBytes(16).toString('hex');
      const passwordHash = await boundedPasswordHash(password, salt);
      if (passwordHash === null) return held('authentication_busy');
      return transact(() => {
        const reset = findReset.get(codeHash);
        if (!usable(reset)) return held('reset_unavailable');
        const user = findUser.get(reset.user_id);
        if (!user) return held('reset_unavailable');
        useReset.run(now(), reset.id);
        updatePassword.run(salt, passwordHash, reset.user_id);
        deleteUserSessions.run(reset.user_id);
        return { state: 'reset', username: user.username };
      });
    },
    async registerInvite({ code, username, password }) {
      if (invitedAccountValidation({ code, username, password })) {
        throw new TypeError('Invalid invited account');
      }
      const codeHash = digest(code);
      if (!inviteUsable(findInvite.get(codeHash), now())) return held('invite_unavailable');
      const salt = randomBytes(16).toString('hex');
      const passwordHash = await boundedPasswordHash(password, salt);
      if (passwordHash === null) return held('authentication_busy');
      return transact(() => {
        const invite = findInvite.get(codeHash);
        if (!inviteUsable(invite, now())) return held('invite_unavailable');
        if (findName.get(usernameKey(username))) return held('username_unavailable');
        const id = Number(insertUser.run(allocateDurableId(db, 'users'), username, usernameKey(username), 'member',
          salt, passwordHash, now()).lastInsertRowid);
        useInvite.run(now(), id, invite.id);
        return publicUser(findUser.get(id));
      });
    },
    async authenticate({ username, password }) {
      if (!validUsername(username) || typeof password !== 'string' ||
          Buffer.byteLength(password, 'utf8') > 128) return null;
      const row = findAuth.get(usernameKey(username));
      const salt = row?.password_salt ?? '0'.repeat(32);
      const expected = Buffer.from(row?.password_hash ?? '0'.repeat(64), 'hex');
      const passwordHash = await boundedPasswordHash(password, salt);
      if (passwordHash === null) return { state: 'busy' };
      const actual = Buffer.from(passwordHash, 'hex');
      if (!timingSafeEqual(actual, expected) || !row || row.disabled) return null;
      return publicUser(row);
    },
    // A session cookie without sessionId predates per-device sessions. It is
    // still accepted until its cookie expires, exactly as before.
    getSessionUser({ userId, version, sessionId }) {
      if (!validId(userId) || !validId(version)) return null;
      const row = findUser.get(userId);
      if (!row || row.disabled || row.session_version !== version) return null;
      if (sessionId === undefined) return publicUser(row);
      if (!validSessionId(sessionId)) return null;
      const idHash = digest(sessionId);
      const session = findSession.get(idHash);
      const at = now();
      if (!session || session.user_id !== userId) return null;
      if (sessionExpired(session, at)) { deleteSession.run(idHash); return null; }
      const touched = at - session.last_seen_ms >= SESSION_TOUCH_MS;
      if (touched) touchSession.run(at, idHash);
      return { ...publicUser(row), sessionTouched: touched };
    },
    createSession({ userId }) {
      if (!validId(userId)) throw new TypeError('Invalid user ID');
      const at = now();
      pruneSessions.run(at - SESSION_IDLE_MS, at - SESSION_MAX_MS);
      const sessionId = randomBytes(32).toString('hex');
      insertSession.run(digest(sessionId), userId, at, at);
      return { sessionId };
    },
    endSession({ sessionId }) {
      if (!validSessionId(sessionId)) return false;
      return deleteSession.run(digest(sessionId)).changes === 1;
    },
    getActiveUser({ userId }) {
      if (!validId(userId)) return null;
      const row = findUser.get(userId);
      return row && !row.disabled ? publicUser(row) : null;
    },
    revokeSessions({ userId }) {
      if (!validId(userId)) throw new TypeError('Invalid user ID');
      return transact(() => {
        deleteUserSessions.run(userId);
        return bumpVersion.run(userId).changes === 1;
      });
    },
    listUsers({ adminUserId }) {
      if (!validId(adminUserId)) throw new TypeError('Invalid admin ID');
      const admin = findUser.get(adminUserId);
      if (!admin || admin.role !== 'admin' || admin.disabled) return held('admin_required');
      return { state: 'users', items: listAccounts.all().map((row) => ({
        id: row.id, username: row.username, role: row.role,
        disabled: row.disabled === 1, adultAllowed: row.adult_allowed === 1,
      })) };
    },
    setAdultAllowed({ adminUserId, userId, allowed }) {
      if (!validId(adminUserId) || !validId(userId) || typeof allowed !== 'boolean') {
        throw new TypeError('Invalid account setting');
      }
      return transact(() => {
        const admin = findUser.get(adminUserId);
        if (!admin || admin.role !== 'admin' || admin.disabled) return held('admin_required');
        if (updateAdult.run(Number(allowed), userId).changes !== 1) return held('user_unavailable');
        return { state: 'updated', userId, adultAllowed: allowed };
      });
    },
    // Disabling signs the account out everywhere and blocks sign-in until an
    // admin enables it again. Requests and history are kept. An admin cannot
    // disable their own account, so there is always one admin left.
    setDisabled({ adminUserId, userId, disabled }) {
      if (!validId(adminUserId) || !validId(userId) || typeof disabled !== 'boolean') {
        throw new TypeError('Invalid account setting');
      }
      return transact(() => {
        const admin = findUser.get(adminUserId);
        if (!admin || admin.role !== 'admin' || admin.disabled) return held('admin_required');
        if (userId === adminUserId) return held('cannot_disable_self');
        if (!findUser.get(userId)) return held('user_unavailable');
        if (disabled) {
          deleteUserSessions.run(userId);
          bumpVersion.run(userId);
        }
        updateDisabled.run(Number(disabled), userId);
        return { state: 'updated', userId, disabled };
      });
    },
    close() { db.close(); },
  };
}
