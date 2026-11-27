import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openAccountLedger, SESSION_IDLE_MS, SESSION_MAX_MS }
  from '../src/auth/account-ledger.mjs';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

async function withLedger(run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-sessions-'));
  const dbPath = path.join(dir, 'accounts.sqlite');
  const clock = { time: 1_000_000 };
  const ledger = openAccountLedger(dbPath, { now: () => clock.time });
  try {
    const user = await ledger.bootstrapAdmin({ username: 'Owner',
      password: 'long-owner-passphrase' });
    await run({ ledger, user, clock, dbPath });
  } finally {
    ledger.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const lookup = (ledger, user, sessionId) => ledger.getSessionUser({
  userId: user.id, version: user.sessionVersion, sessionId });

test('session limits are a 7-day idle window and a 30-day absolute cap', () => {
  assert.equal(SESSION_IDLE_MS, 7 * DAY);
  assert.equal(SESSION_MAX_MS, 30 * DAY);
});

test('a new session is valid and stored only as a digest', () =>
  withLedger(async ({ ledger, user, dbPath }) => {
    const { sessionId } = ledger.createSession({ userId: user.id });
    assert.match(sessionId, /^[0-9a-f]{64}$/);
    const found = lookup(ledger, user, sessionId);
    assert.equal(found.id, user.id);
    assert.equal(found.sessionTouched, false);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db.prepare('SELECT id_hash FROM user_sessions').all();
      assert.equal(rows.length, 1);
      assert.notEqual(rows[0].id_hash, sessionId);
    } finally { db.close(); }
  }));

test('cookies without a session ID keep the pre-upgrade behaviour', () =>
  withLedger(async ({ ledger, user }) => {
    const found = lookup(ledger, user, undefined);
    assert.equal(found.id, user.id);
    assert.equal('sessionTouched' in found, false);
  }));

test('malformed, unknown and other users\' session IDs are rejected', () =>
  withLedger(async ({ ledger, user }) => {
    assert.equal(lookup(ledger, user, 'not-a-session'), null);
    assert.equal(lookup(ledger, user, 'a'.repeat(64)), null);
    assert.equal(lookup(ledger, user, 42), null);
    const { sessionId } = ledger.createSession({ userId: user.id });
    assert.equal(ledger.getSessionUser({ userId: user.id + 1,
      version: user.sessionVersion, sessionId }), null);
    assert.throws(() => ledger.createSession({ userId: 0 }), TypeError);
  }));

test('last-seen is written at most every five minutes', () =>
  withLedger(async ({ ledger, user, clock }) => {
    const { sessionId } = ledger.createSession({ userId: user.id });
    clock.time += 1 * MINUTE;
    assert.equal(lookup(ledger, user, sessionId).sessionTouched, false);
    clock.time += 5 * MINUTE;
    assert.equal(lookup(ledger, user, sessionId).sessionTouched, true);
    clock.time += 1 * MINUTE;
    assert.equal(lookup(ledger, user, sessionId).sessionTouched, false);
  }));

test('an unused session expires after the idle window', () =>
  withLedger(async ({ ledger, user, clock }) => {
    const { sessionId } = ledger.createSession({ userId: user.id });
    clock.time += SESSION_IDLE_MS + 1;
    assert.equal(lookup(ledger, user, sessionId), null);
    clock.time -= 2;
    assert.equal(lookup(ledger, user, sessionId), null, 'an expired row is deleted');
  }));

test('daily use extends a session but never past the absolute cap', () =>
  withLedger(async ({ ledger, user, clock }) => {
    const start = clock.time;
    const { sessionId } = ledger.createSession({ userId: user.id });
    for (let day = 1; day <= 30; day++) {
      clock.time = start + day * DAY;
      assert.ok(lookup(ledger, user, sessionId), `day ${day}`);
    }
    clock.time = start + SESSION_MAX_MS + 1;
    assert.equal(lookup(ledger, user, sessionId), null);
  }));

test('ending one session leaves the user\'s other devices signed in', () =>
  withLedger(async ({ ledger, user }) => {
    const phone = ledger.createSession({ userId: user.id }).sessionId;
    const laptop = ledger.createSession({ userId: user.id }).sessionId;
    assert.equal(ledger.endSession({ sessionId: phone }), true);
    assert.equal(ledger.endSession({ sessionId: phone }), false);
    assert.equal(ledger.endSession({ sessionId: 'bogus' }), false);
    assert.equal(lookup(ledger, user, phone), null);
    assert.equal(lookup(ledger, user, laptop).id, user.id);
  }));

test('revoking sessions ends every device and every pre-upgrade cookie', () =>
  withLedger(async ({ ledger, user }) => {
    const phone = ledger.createSession({ userId: user.id }).sessionId;
    const laptop = ledger.createSession({ userId: user.id }).sessionId;
    assert.equal(ledger.revokeSessions({ userId: user.id }), true);
    assert.equal(lookup(ledger, user, phone), null);
    assert.equal(lookup(ledger, user, laptop), null);
    assert.equal(lookup(ledger, user, undefined), null);
    const fresh = ledger.getActiveUser({ userId: user.id });
    const next = ledger.createSession({ userId: user.id }).sessionId;
    assert.equal(ledger.getSessionUser({ userId: user.id,
      version: fresh.sessionVersion, sessionId: next }).id, user.id);
  }));

test('creating a session prunes expired rows', () =>
  withLedger(async ({ ledger, user, clock, dbPath }) => {
    ledger.createSession({ userId: user.id });
    ledger.createSession({ userId: user.id });
    clock.time += SESSION_IDLE_MS + 1;
    ledger.createSession({ userId: user.id });
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user_sessions').get().n, 1);
    } finally { db.close(); }
  }));

test('reopening an existing database keeps sessions (idempotent schema)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-sessions-'));
  const dbPath = path.join(dir, 'accounts.sqlite');
  try {
    let ledger = openAccountLedger(dbPath, { now: () => 1_000 });
    const user = await ledger.bootstrapAdmin({ username: 'Owner',
      password: 'long-owner-passphrase' });
    const { sessionId } = ledger.createSession({ userId: user.id });
    ledger.close();
    ledger = openAccountLedger(dbPath, { now: () => 2_000 });
    try { assert.equal(lookup(ledger, user, sessionId).id, user.id); }
    finally { ledger.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
