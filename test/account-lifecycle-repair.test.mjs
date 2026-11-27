import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openAccountLedger } from '../src/auth/account-ledger.mjs';
import { deleteAccount } from '../src/auth/delete-account.mjs';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { openAcquisitionLedger } from '../src/acquisition/acquisition-ledger.mjs';
import { openAcquisitionRequestQueue } from '../src/acquisition/acquisition-request-queue.mjs';
import { openStartQueue } from '../src/acquisition/start-queue.mjs';

const candidate = { indexerId: 7, guid: 'fixture-candidate' };
const hash = 'a'.repeat(40);
async function fixture(run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-lifecycle-repair-'));
  const dbPath = path.join(dir, 'state.sqlite');
  let accounts = openAccountLedger(dbPath, { now: () => 100 });
  const owner = await accounts.bootstrapAdmin({ username: 'Owner', password: 'owner-fixture-password' });
  const { code } = accounts.createInvite({ adminUserId: owner.id, expiresMs: 10000 });
  const member = await accounts.registerInvite({ code, username: 'Member', password: 'member-fixture-password' });
  const requests = openRequestLedger(dbPath);
  const acquisitions = openAcquisitionLedger(dbPath);
  const db = new DatabaseSync(dbPath);
  const submit = (requesterId = member.id, key = 'one') => requests.submit({ requesterId, requestKey: key,
    nowMs: 101, intent: { state: 'ready', anidbId: 42, kind: 'series', monitorFuture: true,
      episodeIds: [1001] } }).requestId;
  const reserve = requestId => acquisitions.reserve({ requestId, candidate, episodeIds: [1001], nowMs: 102 }).attemptId;
  const disable = () => accounts.setDisabled({ adminUserId: owner.id, userId: member.id, disabled: true });
  const remove = () => deleteAccount(dbPath, { adminUserId: owner.id, userId: member.id });
  const invite = async (username = 'Replacement') => {
    const invitation = accounts.createInvite({ adminUserId: owner.id, expiresMs: 10000 });
    return accounts.registerInvite({ code: invitation.code, username, password: 'replacement-fixture-password' });
  };
  const observe = attemptId => {
    acquisitions.bindPreparedTorrent({ attemptId, candidate, hash, nowMs: 103 });
    acquisitions.recordFilePlan({ attemptId, hash,
      plannedFiles: [{ name: 'Fixture.mkv', size: 1000, episodeIds: [1001] }], nowMs: 103 });
    acquisitions.beginDispatch({ attemptId, nowMs: 104 });
    acquisitions.recordTorrent({ attemptId, hash, nowMs: 105 });
  };
  try {
    await run({ accounts, owner, member, requests, acquisitions, db, dbPath, submit, reserve,
      disable, remove, invite, observe,
      reopenAccounts() { accounts.close(); accounts = null;
        accounts = openAccountLedger(dbPath, { now: () => 100 }); return accounts; } });
  } finally { db.close(); acquisitions.close(); requests.close(); accounts?.close(); await rm(dir, { recursive: true, force: true }); }
}

test('deleted highest account ID is never reused, including after reopening', () => fixture(async f => {
  f.disable(); assert.equal(f.remove().state, 'deleted'); f.reopenAccounts();
  assert.ok((await f.invite()).id > f.member.id);
}));

test('a legacy orphan requester ID is not assigned to a new account', () => fixture(async f => {
  f.submit(70); const user = await f.invite();
  assert.ok(user.id > 70);
  assert.deepEqual(f.requests.listRequests({ requesterId: user.id }).items, []);
}));

test('deleted request and reservation IDs cannot be reused by stale workers', () => fixture(async f => {
  const requestId = f.submit(), attemptId = f.reserve(requestId);
  f.disable(); assert.equal(f.remove().state, 'deleted');
  const next = f.submit(f.owner.id, 'next');
  const reserved = f.acquisitions.reserve({ requestId: next, candidate,
    episodeIds: [1001], nowMs: 110 });
  assert.ok(next > requestId); assert.ok(reserved.attemptId > attemptId);
  assert.equal(f.acquisitions.beginDispatch({ attemptId, nowMs: 111 }).reason, 'attempt_missing');
}));

test('deleting an admin preserves its used invite without a creator and removes its unused invite', () => fixture(async f => {
  f.db.prepare("UPDATE users SET role='admin' WHERE id=?").run(f.member.id);
  const used = f.accounts.createInvite({ adminUserId: f.member.id, expiresMs: 10000 });
  await f.accounts.registerInvite({ code: used.code, username: 'Invitee', password: 'invitee-fixture-password' });
  const unused = f.accounts.createInvite({ adminUserId: f.member.id, expiresMs: 10000 });
  f.disable(); assert.equal(f.remove().state, 'deleted');
  const invites = f.accounts.listInvites({ adminUserId: f.owner.id }).items;
  assert.equal(invites.find(x => x.id === used.id).status, 'used');
  assert.equal(invites.find(x => x.id === used.id).createdBy, null);
  assert.equal(invites.find(x => x.id === unused.id), undefined);
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
}));

test('legacy invitation migration preserves the used link and other account state', () => fixture(async f => {
  const session = f.accounts.createSession({ userId: f.owner.id });
  // Recreate precisely the old NOT NULL creator schema on this disposable database.
  f.db.exec(`CREATE TABLE old_invites (id INTEGER PRIMARY KEY,code_hash TEXT NOT NULL UNIQUE,
    created_by INTEGER NOT NULL REFERENCES users(id),expires_ms INTEGER NOT NULL CHECK(expires_ms>=0),
    used_ms INTEGER CHECK(used_ms>=0),created_ms INTEGER CHECK(created_ms>=0),
    revoked_ms INTEGER CHECK(revoked_ms>=0),used_by INTEGER REFERENCES users(id)) STRICT;
    INSERT INTO old_invites SELECT id,code_hash,created_by,expires_ms,used_ms,created_ms,revoked_ms,used_by FROM invitations;
    DROP TABLE invitations; ALTER TABLE old_invites RENAME TO invitations;`);
  const before = f.db.prepare('SELECT * FROM invitations').all();
  const accounts = f.reopenAccounts();
  assert.equal(f.db.prepare('PRAGMA table_info(invitations)').all().find(x => x.name === 'created_by').notnull, 0);
  assert.deepEqual(f.db.prepare('SELECT * FROM invitations').all(), before);
  assert.equal(accounts.getSessionUser({ userId: f.owner.id, version: 1, sessionId: session.sessionId }).id, f.owner.id);
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
}));

test('a prepared but undispatched reservation is removed without being counted as started', () => fixture(async f => {
  const id = f.submit(), attemptId = f.reserve(id);
  f.acquisitions.bindPreparedTorrent({ attemptId, candidate, hash, nowMs: 103 });
  f.acquisitions.recordFilePlan({ attemptId, hash,
    plannedFiles: [{ name: 'Fixture.mkv', size: 1000, episodeIds: [1001] }], nowMs: 103 });
  f.disable(); const result = f.remove();
  assert.equal(result.deletedRequests, 1); assert.equal(result.keptStartedRequests, 0);
  assert.equal(f.requests.getRequest(id), null); assert.equal(f.acquisitions.getAttempt(attemptId), null);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM acquisition_target_claims').get().n, 0);
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
}));

test('legacy dangling invitation names are detached without blocking startup', () => fixture(async f => {
  f.db.exec(`PRAGMA foreign_keys=OFF;
    CREATE TABLE old_invites (id INTEGER PRIMARY KEY,code_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER NOT NULL REFERENCES users(id),expires_ms INTEGER NOT NULL CHECK(expires_ms>=0),
      used_ms INTEGER CHECK(used_ms>=0),created_ms INTEGER CHECK(created_ms>=0),
      revoked_ms INTEGER CHECK(revoked_ms>=0),used_by INTEGER REFERENCES users(id)) STRICT;
    INSERT INTO old_invites SELECT id,code_hash,700,expires_ms,used_ms,created_ms,revoked_ms,701 FROM invitations;
    DROP TABLE invitations; ALTER TABLE old_invites RENAME TO invitations;
    PRAGMA foreign_keys=ON;`);
  const before = f.db.prepare('SELECT code_hash,used_ms FROM invitations').get();
  const accounts = f.reopenAccounts();
  const item = accounts.listInvites({ adminUserId: f.owner.id }).items[0];
  assert.equal(item.status, 'used'); assert.equal(item.createdBy, null); assert.equal(item.usedBy, null);
  assert.deepEqual(f.db.prepare('SELECT code_hash,used_ms FROM invitations').get(), before);
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
}));

for (const state of ['dispatch_unknown', 'torrent_observed']) {
  test('deletion waits for reconciliation of an unstarted ' + state + ' attempt without partial changes', () => fixture(async f => {
    const id = f.submit(), attemptId = f.reserve(id);
    if (state === 'torrent_observed') f.observe(attemptId);
    else { f.acquisitions.bindPreparedTorrent({ attemptId, candidate, hash, nowMs: 103 });
      f.acquisitions.beginDispatch({ attemptId, nowMs: 104 }); }
    f.disable(); assert.deepEqual(f.remove(), { state: 'held', reason: 'acquisition_unsettled' });
    assert.ok(f.db.prepare('SELECT id FROM users WHERE id=?').get(f.member.id));
    assert.equal(f.requests.getRequest(id).watchClosed, false);
    assert.equal(f.acquisitions.getAttempt(attemptId).status, state);
  }));
}

test('an actual start intent stays as closed history and never changes owner', () => fixture(async f => {
  const id = f.submit(), attemptId = f.reserve(id); f.observe(attemptId);
  f.acquisitions.beginStart({ attemptId, hash, manifestDigest: 'b'.repeat(64), nowMs: 106 });
  f.disable(); const result = f.remove();
  assert.equal(result.deletedRequests, 0); assert.equal(result.keptStartedRequests, 1);
  assert.equal(f.requests.getRequest(id).watchClosed, true);
  const next = await f.invite(); assert.notEqual(next.id, f.member.id);
  assert.deepEqual(f.requests.listRequests({ requesterId: next.id }).items, []);
  assert.equal(f.acquisitions.getStart(attemptId).status, 'start_unknown');
}));

test('disabled ownership blocks reservation and resumes after re-enable', () => fixture(async f => {
  const id = f.submit(); f.disable();
  assert.equal(f.acquisitions.reserve({ requestId: id, candidate, episodeIds: [1001], nowMs: 102 }).reason, 'account_access_changed');
  f.accounts.setDisabled({ adminUserId: f.owner.id, userId: f.member.id, disabled: false });
  assert.equal(f.acquisitions.reserve({ requestId: id, candidate, episodeIds: [1001], nowMs: 103 }).state, 'reserved');
}));

test('disabling after reservation blocks the dispatch transaction', () => fixture(async f => {
  const id = f.submit(), attemptId = f.reserve(id);
  f.acquisitions.bindPreparedTorrent({ attemptId, candidate, hash, nowMs: 103 }); f.disable();
  assert.equal(f.acquisitions.beginDispatch({ attemptId, nowMs: 104 }).reason, 'account_access_changed');
  assert.equal(f.acquisitions.getAttempt(attemptId).status, 'reserved');
}));

test('disabling a stopped download blocks a new start but permits an existing intent to reconcile', () => fixture(async f => {
  const id = f.submit(), attemptId = f.reserve(id); f.observe(attemptId); f.disable();
  const input = { attemptId, hash, manifestDigest: 'b'.repeat(64), nowMs: 106 };
  assert.equal(f.acquisitions.beginStart(input).reason, 'account_access_changed');
  assert.equal(f.acquisitions.getStart(attemptId), null);
  f.accounts.setDisabled({ adminUserId: f.owner.id, userId: f.member.id, disabled: false });
  assert.equal(f.acquisitions.beginStart(input).sendNow, true); f.disable();
  assert.equal(f.acquisitions.beginStart({ ...input, nowMs: 107 }).sendNow, false);
}));

test('an orphaned request cannot be claimed or reserved when accounts exist', () => fixture(async f => {
  const id = f.submit(700);
  const queue = openAcquisitionRequestQueue(f.dbPath);
  try { assert.equal(queue.claimNext({ nowMs: 110, priorityRequestId: id }).state, 'pass_complete'); }
  finally { queue.close(); }
  assert.equal(f.acquisitions.reserve({ requestId: id, candidate, episodeIds: [1001], nowMs: 111 }).reason, 'account_access_changed');
}));

test('a pause during a later start claim resumes automatically after re-enable', () => fixture(async f => {
  const id = f.submit(), attemptId = f.reserve(id); f.observe(attemptId);
  const queue = openStartQueue(f.dbPath);
  try {
    let claim = queue.claimNext({ nowMs: 110 });
    queue.recordResult({ ...claim, state: 'held', reason: 'provider_unavailable', checkedMs: 110 });
    claim = queue.claimNext({ nowMs: 60111 }); assert.equal(claim.version, 2);
    f.disable();
    const result = f.acquisitions.beginStart({ attemptId, hash, manifestDigest: 'b'.repeat(64), nowMs: 60112 });
    assert.equal(result.reason, 'account_access_changed');
    queue.recordResult({ ...claim, ...result, checkedMs: 60112 });
    assert.equal(queue.getResult(attemptId).nextDueMs, 120112);
    assert.equal(queue.claimNext({ nowMs: 120113 }).state, 'idle');
    f.accounts.setDisabled({ adminUserId: f.owner.id, userId: f.member.id, disabled: false });
    assert.equal(queue.claimNext({ nowMs: 120114 }).attemptId, attemptId);
  } finally { queue.close(); }
}));
