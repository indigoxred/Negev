import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openAccountLedger } from '../src/auth/account-ledger.mjs';
import { buildUserApp } from '../src/web/user-app.mjs';

const origin = 'http://localhost:3000';
const ownerPassword = 'long-owner-passphrase';
const DAY = 24 * 60 * 60 * 1000;

async function withApp(run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-admin-tools-'));
  const dbPath = path.join(dir, 'accounts.sqlite');
  const clock = { time: 1_000_000 };
  const accounts = openAccountLedger(dbPath, { now: () => clock.time });
  const owner = await accounts.bootstrapAdmin({ username: 'Owner', password: ownerPassword });
  const app = await buildUserApp({ accounts, sessionKey: randomBytes(32),
    publicOrigin: origin, secureCookies: false, now: () => clock.time,
    submitRequest: async () => null, readRequest: () => null });
  try { await run({ app, accounts, owner, clock, dbPath }); }
  finally {
    await app.close();
    accounts.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const cookieOf = (response) => {
  const header = response.headers['set-cookie'];
  return (Array.isArray(header) ? header[0] : header)?.split(';')[0];
};
async function signIn(app, username, password) {
  const login = await app.inject({ method: 'POST', url: '/api/login',
    headers: { origin }, payload: { username, password } });
  if (login.statusCode !== 200) return { status: login.statusCode };
  const cookie = cookieOf(login);
  const session = await app.inject({ method: 'GET', url: '/api/session', headers: { cookie } });
  return { status: 200, cookie: cookieOf(session) ?? cookie, csrf: session.json().csrfToken };
}
const post = (app, who, url, payload = {}) => app.inject({ method: 'POST', url,
  headers: { cookie: who.cookie, origin, 'x-negev-csrf': who.csrf }, payload });

test('admins list invitations with their status and can revoke an unused one', () =>
  withApp(async ({ app }) => {
    const admin = await signIn(app, 'Owner', ownerPassword);
    const first = (await post(app, admin, '/api/invitations')).json();
    const second = (await post(app, admin, '/api/invitations')).json();
    assert.match(first.code, /^[a-f0-9]{64}$/);
    const registered = await app.inject({ method: 'POST', url: '/api/register', headers: { origin },
      payload: { code: first.code, username: 'Friend', password: 'long-member-passphrase' } });
    assert.equal(registered.statusCode, 201, registered.body);
    const revoked = await post(app, admin, `/api/admin/invitations/${second.id}/revoke`);
    assert.equal(revoked.statusCode, 200, revoked.body);
    assert.equal((await post(app, admin, `/api/admin/invitations/${second.id}/revoke`)).statusCode, 409);
    assert.equal((await post(app, admin, `/api/admin/invitations/${first.id}/revoke`)).statusCode, 409,
      'a used invitation cannot be revoked');
    const blocked = await app.inject({ method: 'POST', url: '/api/register', headers: { origin },
      payload: { code: second.code, username: 'Other', password: 'long-member-passphrase' } });
    assert.equal(blocked.statusCode, 409, 'a revoked invitation cannot be used');
    const list = await app.inject({ method: 'GET', url: '/api/admin/invitations',
      headers: { cookie: admin.cookie } });
    assert.equal(list.statusCode, 200, list.body);
    const byId = new Map(list.json().items.map((item) => [item.id, item]));
    assert.equal(byId.get(first.id).status, 'used');
    assert.equal(byId.get(first.id).usedBy, 'Friend');
    assert.equal(byId.get(first.id).createdBy, 'Owner');
    assert.equal(byId.get(second.id).status, 'revoked');
    assert.equal(JSON.stringify(list.json()).includes(first.code), false, 'codes are never listed');
  }));

test('invitations past their expiry are listed as expired', () =>
  withApp(async ({ app, clock }) => {
    const admin = await signIn(app, 'Owner', ownerPassword);
    const invite = (await post(app, admin, '/api/invitations')).json();
    clock.time += 8 * DAY;
    const again = await signIn(app, 'Owner', ownerPassword);
    const list = await app.inject({ method: 'GET', url: '/api/admin/invitations',
      headers: { cookie: again.cookie } });
    assert.equal(list.json().items.find((item) => item.id === invite.id).status, 'expired');
  }));

test('a password reset link sets a new password once and signs the account out', () =>
  withApp(async ({ app, accounts, owner }) => {
    const { code } = accounts.createInvite({ adminUserId: owner.id, expiresMs: 2_000_000 });
    const member = await accounts.registerInvite({ code, username: 'Friend',
      password: 'long-member-passphrase' });
    const memberSession = await signIn(app, 'Friend', 'long-member-passphrase');
    const admin = await signIn(app, 'Owner', ownerPassword);
    const created = await post(app, admin, `/api/admin/users/${member.id}/password-reset`);
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.json().username, 'Friend');
    const reset = await app.inject({ method: 'POST', url: '/api/password-reset', headers: { origin },
      payload: { code: created.json().code, password: 'brand-new-passphrase' } });
    assert.equal(reset.statusCode, 200, reset.body);
    assert.deepEqual(reset.json(), { state: 'reset', username: 'Friend' });
    assert.equal((await app.inject({ method: 'GET', url: '/api/session',
      headers: { cookie: memberSession.cookie } })).statusCode, 401, 'old sessions end');
    assert.equal((await signIn(app, 'Friend', 'long-member-passphrase')).status, 401);
    assert.equal((await signIn(app, 'Friend', 'brand-new-passphrase')).status, 200);
    const reused = await app.inject({ method: 'POST', url: '/api/password-reset', headers: { origin },
      payload: { code: created.json().code, password: 'another-new-passphrase' } });
    assert.equal(reused.statusCode, 409, 'a reset link works once');
  }));

test('a newer reset link replaces an older one, and links expire after a day', () =>
  withApp(async ({ app, owner, clock }) => {
    const admin = await signIn(app, 'Owner', ownerPassword);
    const older = (await post(app, admin, `/api/admin/users/${owner.id}/password-reset`)).json();
    const newer = (await post(app, admin, `/api/admin/users/${owner.id}/password-reset`)).json();
    const tryReset = (code) => app.inject({ method: 'POST', url: '/api/password-reset',
      headers: { origin }, payload: { code, password: 'brand-new-passphrase' } });
    assert.equal((await tryReset(older.code)).statusCode, 409);
    clock.time += DAY + 1;
    assert.equal((await tryReset(newer.code)).statusCode, 409);
  }));

test('reset and invitation admin routes need an admin and valid input', () =>
  withApp(async ({ app, accounts, owner }) => {
    const { code } = accounts.createInvite({ adminUserId: owner.id, expiresMs: 2_000_000 });
    await accounts.registerInvite({ code, username: 'Friend', password: 'long-member-passphrase' });
    const member = await signIn(app, 'Friend', 'long-member-passphrase');
    assert.equal((await post(app, member, `/api/admin/users/${owner.id}/password-reset`)).statusCode, 403);
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/invitations',
      headers: { cookie: member.cookie } })).statusCode, 403);
    assert.equal((await post(app, member, '/api/admin/invitations/1/revoke')).statusCode, 403);
    const admin = await signIn(app, 'Owner', ownerPassword);
    assert.equal((await post(app, admin, '/api/admin/users/999/password-reset')).statusCode, 404);
    assert.equal((await post(app, admin, '/api/admin/users/abc/password-reset')).statusCode, 400);
    const badCode = await app.inject({ method: 'POST', url: '/api/password-reset', headers: { origin },
      payload: { code: 'short', password: 'brand-new-passphrase' } });
    assert.equal(badCode.statusCode, 400);
    const shortPassword = await app.inject({ method: 'POST', url: '/api/password-reset',
      headers: { origin }, payload: { code: 'a'.repeat(64), password: 'short' } });
    assert.equal(shortPassword.statusCode, 400);
    assert.equal(shortPassword.json().field, 'password');
  }));

test('reset codes are stored only as digests and older databases gain the new columns', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-admin-schema-'));
  const dbPath = path.join(dir, 'accounts.sqlite');
  try {
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL,
      username_key TEXT NOT NULL UNIQUE, role TEXT NOT NULL, password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL, session_version INTEGER NOT NULL DEFAULT 1,
      disabled INTEGER NOT NULL DEFAULT 0, created_ms INTEGER NOT NULL) STRICT`);
    legacy.exec(`CREATE TABLE invitations (id INTEGER PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER NOT NULL, expires_ms INTEGER NOT NULL, used_ms INTEGER) STRICT`);
    legacy.close();
    const ledger = openAccountLedger(dbPath, { now: () => 1_000 });
    try {
      const owner = await ledger.bootstrapAdmin({ username: 'Owner', password: ownerPassword });
      const reset = ledger.createPasswordReset({ adminUserId: owner.id, userId: owner.id,
        expiresMs: 5_000 });
      const invite = ledger.createInvite({ adminUserId: owner.id, expiresMs: 5_000 });
      assert.equal(ledger.listInvites({ adminUserId: owner.id }).items[0].status, 'active');
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const stored = db.prepare('SELECT code_hash FROM password_resets').all();
        assert.equal(stored.length, 1);
        assert.notEqual(stored[0].code_hash, reset.code);
        const columns = db.prepare('PRAGMA table_info(invitations)').all().map((c) => c.name);
        for (const name of ['created_ms', 'revoked_ms', 'used_by']) assert.ok(columns.includes(name), name);
        assert.notEqual(db.prepare('SELECT code_hash FROM invitations').get().code_hash, invite.code);
      } finally { db.close(); }
    } finally { ledger.close(); }
    // Reopening is idempotent.
    openAccountLedger(dbPath, { now: () => 2_000 }).close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('an older active invitation remains reachable and revocable after fifty newer revocations',()=>withApp(async({app,accounts,owner,clock})=>{
 const first=accounts.createInvite({adminUserId:owner.id,expiresMs:clock.time+7*DAY});
 for(let i=0;i<50;i++){const invite=accounts.createInvite({adminUserId:owner.id,expiresMs:clock.time+DAY});accounts.revokeInvite({adminUserId:owner.id,inviteId:invite.id})}
 const who=await signIn(app,'Owner',ownerPassword),headers={cookie:who.cookie};
 const page=(await app.inject({url:'/api/admin/invitations',headers})).json();assert.equal(page.items.length,50);assert.ok(page.nextBeforeId);
 const older=await app.inject({url:'/api/admin/invitations?beforeId='+page.nextBeforeId,headers});assert.equal(older.statusCode,200);
 assert.equal(older.json().items[0].id,first.id);assert.equal(older.json().items[0].status,'active');assert.equal(older.json().nextBeforeId,null);assert.equal(older.body.includes(first.code),false);
 assert.equal((await post(app,who,'/api/admin/invitations/'+first.id+'/revoke')).statusCode,200);
 assert.equal((await app.inject({url:'/api/admin/invitations?beforeId=0',headers})).statusCode,400);
 assert.equal((await app.inject({url:'/api/admin/invitations?extra=1',headers})).statusCode,400);
}));
