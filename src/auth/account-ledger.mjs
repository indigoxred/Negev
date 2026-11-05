import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

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
      created_by INTEGER NOT NULL REFERENCES users(id),
      expires_ms INTEGER NOT NULL CHECK(expires_ms>=0),
      used_ms INTEGER CHECK(used_ms>=0)
    ) STRICT`);
    db.exec('PRAGMA foreign_keys=ON');
  } catch (error) { db.close(); throw error; }
  const countUsers = db.prepare('SELECT COUNT(*) AS count FROM users');
  const insertUser = db.prepare(`INSERT INTO users
    (username,username_key,role,password_salt,password_hash,created_ms)
    VALUES (?,?,?,?,?,?)`);
  const findName = db.prepare('SELECT id FROM users WHERE username_key=?');
  const findAuth = db.prepare(`SELECT id,username,role,password_salt,password_hash,
    session_version,disabled,adult_allowed FROM users WHERE username_key=?`);
  const findUser = db.prepare(`SELECT id,username,role,session_version,disabled,adult_allowed
    FROM users WHERE id=?`);
  const listAccounts = db.prepare(`SELECT id,username,role,disabled,adult_allowed
    FROM users ORDER BY id`);
  const updateAdult = db.prepare(`UPDATE users SET adult_allowed=? WHERE id=? AND disabled=0`);
  const insertInvite = db.prepare(`INSERT INTO invitations
    (code_hash,created_by,expires_ms) VALUES (?,?,?)`);
  const findInvite = db.prepare('SELECT id,expires_ms,used_ms FROM invitations WHERE code_hash=?');
  const useInvite = db.prepare('UPDATE invitations SET used_ms=? WHERE id=? AND used_ms IS NULL');
  const bumpVersion = db.prepare(`UPDATE users SET session_version=session_version+1
    WHERE id=? AND disabled=0`);
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
    async bootstrapAdmin({ username, password }) {
      if (!validUsername(username) || !validPassword(password)) {
        throw new TypeError('Invalid admin credentials');
      }
      if (countUsers.get().count !== 0) return null;
      const salt = randomBytes(16).toString('hex');
      const passwordHash = await hashPassword(password, salt);
      return transact(() => {
        if (countUsers.get().count !== 0) return null;
        const id = Number(insertUser.run(username, usernameKey(username), 'admin',
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
      insertInvite.run(digest(code), adminUserId, expiresMs);
      return { state: 'created', code, expiresMs };
    },
    async registerInvite({ code, username, password }) {
      if (typeof code !== 'string' || !/^[a-f0-9]{64}$/.test(code) ||
          !validUsername(username) || !validPassword(password)) {
        throw new TypeError('Invalid invited account');
      }
      const codeHash = digest(code);
      const current = findInvite.get(codeHash);
      if (!current || current.used_ms !== null || current.expires_ms <= now()) {
        return held('invite_unavailable');
      }
      const salt = randomBytes(16).toString('hex');
      const passwordHash = await boundedPasswordHash(password, salt);
      if (passwordHash === null) return held('authentication_busy');
      return transact(() => {
        const invite = findInvite.get(codeHash);
        if (!invite || invite.used_ms !== null || invite.expires_ms <= now()) {
          return held('invite_unavailable');
        }
        if (findName.get(usernameKey(username))) return held('username_unavailable');
        const id = Number(insertUser.run(username, usernameKey(username), 'member',
          salt, passwordHash, now()).lastInsertRowid);
        useInvite.run(now(), invite.id);
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
    getSessionUser({ userId, version }) {
      if (!validId(userId) || !validId(version)) return null;
      const row = findUser.get(userId);
      return row && !row.disabled && row.session_version === version ? publicUser(row) : null;
    },
    revokeSessions({ userId }) {
      if (!validId(userId)) throw new TypeError('Invalid user ID');
      return bumpVersion.run(userId).changes === 1;
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
    close() { db.close(); },
  };
}
