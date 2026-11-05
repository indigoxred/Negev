import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openAccountLedger } from '../src/auth/account-ledger.mjs';

async function withAccounts(run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-accounts-'));
  const dbPath = path.join(dir, 'accounts.sqlite');
  try { await run(dbPath); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

test('offline admin bootstrap and one-use invitation create separate durable users', async () =>
  withAccounts(async (dbPath) => {
    const first = openAccountLedger(dbPath, { now: () => 1_000 });
    let admin;
    try {
      admin = await first.bootstrapAdmin({ username: 'Owner', password: 'long-owner-passphrase' });
      assert.equal(admin.role, 'admin');
      assert.equal(admin.username, 'Owner');
      assert.equal(await first.bootstrapAdmin({ username: 'Other', password: 'another-long-passphrase' }), null);
      const invite = first.createInvite({ adminUserId: admin.id, expiresMs: 100_000 });
      assert.match(invite.code, /^[a-f0-9]{64}$/);
      const member = await first.registerInvite({ code: invite.code, username: 'Friend',
        password: 'long-member-passphrase' });
      assert.equal(member.role, 'member');
      assert.notEqual(member.id, admin.id);
      assert.deepEqual(await first.registerInvite({ code: invite.code, username: 'Again',
        password: 'another-long-passphrase' }), { state: 'held', reason: 'invite_unavailable' });
    } finally { first.close(); }
    const reopened = openAccountLedger(dbPath, { now: () => 2_000 });
    try {
      assert.equal((await reopened.authenticate({ username: 'owner',
        password: 'long-owner-passphrase' })).id, admin.id);
      assert.equal(await reopened.authenticate({ username: 'Owner', password: 'wrong-password' }), null);
      assert.equal((await reopened.authenticate({ username: 'FRIEND',
        password: 'long-member-passphrase' })).role, 'member');
    } finally { reopened.close(); }
  }));

test('expired and duplicate invitations cannot create or elevate users', async () =>
  withAccounts(async (dbPath) => {
    let time = 1_000;
    const ledger = openAccountLedger(dbPath, { now: () => time });
    try {
      const owner = await ledger.bootstrapAdmin({ username: 'Owner', password: 'long-owner-passphrase' });
      assert.deepEqual(ledger.createInvite({ adminUserId: 999, expiresMs: 5_000 }),
        { state: 'held', reason: 'admin_required' });
      const invite = ledger.createInvite({ adminUserId: owner.id, expiresMs: 2_000 });
      time = 2_000;
      assert.deepEqual(await ledger.registerInvite({ code: invite.code, username: 'Friend',
        password: 'long-member-passphrase' }), { state: 'held', reason: 'invite_unavailable' });
      time = 1_000;
      const valid = ledger.createInvite({ adminUserId: owner.id, expiresMs: 3_000 });
      assert.deepEqual(await ledger.registerInvite({ code: valid.code, username: 'OWNER',
        password: 'long-member-passphrase' }), { state: 'held', reason: 'username_unavailable' });
    } finally { ledger.close(); }
  }));

test('admin can disable adult requests for one user without changing other accounts', async () =>
  withAccounts(async (dbPath) => {
    const ledger = openAccountLedger(dbPath, { now: () => 1_000 });
    try {
      const owner = await ledger.bootstrapAdmin({ username: 'Owner', password: 'long-owner-passphrase' });
      const invite = ledger.createInvite({ adminUserId: owner.id, expiresMs: 100_000 });
      const friend = await ledger.registerInvite({ code: invite.code, username: 'Friend',
        password: 'long-member-passphrase' });
      assert.equal(friend.adultAllowed, true);
      assert.equal(ledger.setAdultAllowed({ adminUserId: friend.id, userId: owner.id,
        allowed: false }).state, 'held');
      assert.equal(ledger.setAdultAllowed({ adminUserId: owner.id, userId: friend.id,
        allowed: false }).adultAllowed, false);
      assert.equal(ledger.getSessionUser({ userId: friend.id,
        version: friend.sessionVersion }).adultAllowed, false);
      assert.equal(ledger.getSessionUser({ userId: owner.id,
        version: owner.sessionVersion }).adultAllowed, true);
      assert.equal(ledger.listUsers({ adminUserId: owner.id }).items.length, 2);
    } finally { ledger.close(); }
    const reopened = openAccountLedger(dbPath, { now: () => 2_000 });
    try {
      assert.equal((await reopened.authenticate({ username: 'Friend',
        password: 'long-member-passphrase' })).adultAllowed, false);
    } finally { reopened.close(); }
  }));

test('existing account databases gain the adult setting with access preserved', async () =>
  withAccounts(async (dbPath) => {
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE users (
      id INTEGER PRIMARY KEY, username TEXT NOT NULL, username_key TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL CHECK(role IN ('admin','member')),
      password_salt TEXT NOT NULL, password_hash TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 1 CHECK(session_version>0),
      disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1)),
      created_ms INTEGER NOT NULL CHECK(created_ms>=0)
    ) STRICT`);
    db.close();
    const ledger = openAccountLedger(dbPath);
    try {
      const owner = await ledger.bootstrapAdmin({ username: 'Owner',
        password: 'long-owner-passphrase' });
      assert.equal(owner.adultAllowed, true);
    } finally { ledger.close(); }
  }));

test('session version revokes old sessions without deleting requests or users', async () =>
  withAccounts(async (dbPath) => {
    const ledger = openAccountLedger(dbPath, { now: () => 1_000 });
    try {
      const user = await ledger.bootstrapAdmin({ username: 'Owner', password: 'long-owner-passphrase' });
      assert.equal(ledger.getSessionUser({ userId: user.id, version: user.sessionVersion }).id, user.id);
      ledger.revokeSessions({ userId: user.id });
      assert.equal(ledger.getSessionUser({ userId: user.id, version: user.sessionVersion }), null);
      assert.equal((await ledger.authenticate({ username: 'Owner',
        password: 'long-owner-passphrase' })).sessionVersion, user.sessionVersion + 1);
    } finally { ledger.close(); }
  }));

test('password checks have a shared concurrency bound and recover after a busy response', async () =>
  withAccounts(async (dbPath) => {
    const ledger = openAccountLedger(dbPath, { now: () => 1_000 });
    try {
      const owner = await ledger.bootstrapAdmin({ username: 'Owner',
        password: 'long-owner-passphrase' });
      const invite = ledger.createInvite({ adminUserId: owner.id,
        expiresMs: 100_000 });
      const first = ledger.authenticate({ username: 'Owner',
        password: 'long-owner-passphrase' });
      const second = ledger.authenticate({ username: 'Owner',
        password: 'long-owner-passphrase' });
      assert.deepEqual(await ledger.authenticate({ username: 'Owner',
        password: 'long-owner-passphrase' }), { state: 'busy' });
      assert.deepEqual(await ledger.registerInvite({ code: invite.code,
        username: 'Friend', password: 'long-member-passphrase' }),
      { state: 'held', reason: 'authentication_busy' });
      assert.equal((await first).id, owner.id);
      assert.equal((await second).id, owner.id);
      assert.equal((await ledger.authenticate({ username: 'Owner',
        password: 'long-owner-passphrase' })).id, owner.id);
      assert.equal((await ledger.registerInvite({ code: invite.code,
        username: 'Friend', password: 'long-member-passphrase' })).role,
      'member');
    } finally { ledger.close(); }
  }));
