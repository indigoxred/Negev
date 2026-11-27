import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';
import { openAccountLedger } from '../src/auth/account-ledger.mjs';
import { buildUserApp } from '../src/web/user-app.mjs';

const origin = 'http://localhost:3000';
const password = 'long-owner-passphrase';

async function withApp(run, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-session-http-'));
  const clock = { time: 1_000_000 };
  const accounts = openAccountLedger(path.join(dir, 'accounts.sqlite'),
    { now: () => clock.time });
  await accounts.bootstrapAdmin({ username: 'Owner', password });
  const app = await buildUserApp({ accounts, sessionKey: randomBytes(32),
    publicOrigin: origin, secureCookies: false,
    submitRequest: async () => null, readRequest: () => null, ...options });
  try { await run({ app, accounts, clock }); }
  finally {
    await app.close();
    accounts.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const cookieOf = (response) => {
  const header = response.headers['set-cookie'];
  const first = Array.isArray(header) ? header[0] : header;
  return first?.split(';')[0];
};

async function signIn(app) {
  const login = await app.inject({ method: 'POST', url: '/api/login',
    headers: { origin }, payload: { username: 'Owner', password } });
  assert.equal(login.statusCode, 200, login.body);
  let cookie = cookieOf(login);
  const session = await app.inject({ method: 'GET', url: '/api/session',
    headers: { cookie } });
  assert.equal(session.statusCode, 200, session.body);
  cookie = cookieOf(session) ?? cookie;
  return { cookie, csrf: session.json().csrfToken };
}

const sessionStatus = async (app, cookie) => (await app.inject({ method: 'GET',
  url: '/api/session', headers: { cookie } })).statusCode;

const signOut = (app, { cookie, csrf }, payload = {}) => app.inject({
  method: 'POST', url: '/api/logout',
  headers: { cookie, origin, 'x-negev-csrf': csrf }, payload });

test('signing out ends only this device', () => withApp(async ({ app }) => {
  const phone = await signIn(app);
  const laptop = await signIn(app);
  assert.equal((await signOut(app, phone)).statusCode, 204);
  assert.equal(await sessionStatus(app, phone.cookie), 401);
  assert.equal(await sessionStatus(app, laptop.cookie), 200);
}));

test('signing out everywhere ends every device', () => withApp(async ({ app }) => {
  const phone = await signIn(app);
  const laptop = await signIn(app);
  assert.equal((await signOut(app, phone, { everywhere: true })).statusCode, 204);
  assert.equal(await sessionStatus(app, phone.cookie), 401);
  assert.equal(await sessionStatus(app, laptop.cookie), 401);
}));

test('logout rejects unexpected body fields and non-boolean everywhere', () =>
  withApp(async ({ app }) => {
    const device = await signIn(app);
    assert.equal((await signOut(app, device, { everywhere: 'yes' })).statusCode, 400);
    assert.equal((await signOut(app, device, { other: true })).statusCode, 400);
    assert.equal(await sessionStatus(app, device.cookie), 200);
  }));

test('signing in again on the same browser replaces its old session', () =>
  withApp(async ({ app }) => {
    const first = await signIn(app);
    const again = await app.inject({ method: 'POST', url: '/api/login',
      headers: { origin, cookie: first.cookie },
      payload: { username: 'Owner', password } });
    assert.equal(again.statusCode, 200, again.body);
    assert.equal(await sessionStatus(app, first.cookie), 401);
    assert.equal(await sessionStatus(app, cookieOf(again)), 200);
  }));

test('an active session cookie is re-issued once activity is recorded', () =>
  withApp(async ({ app, clock }) => {
    const { cookie } = await signIn(app);
    clock.time += 60_000;
    const quiet = await app.inject({ method: 'GET', url: '/api/session',
      headers: { cookie } });
    assert.equal(quiet.statusCode, 200);
    assert.equal(quiet.headers['set-cookie'], undefined);
    clock.time += 5 * 60_000;
    const touched = await app.inject({ method: 'GET', url: '/api/session',
      headers: { cookie } });
    assert.equal(touched.statusCode, 200);
    assert.match(String(touched.headers['set-cookie']), /Max-Age=604800/);
  }));

test('an idle session is rejected after seven days', () =>
  withApp(async ({ app, clock }) => {
    const { cookie } = await signIn(app);
    clock.time += 7 * 24 * 60 * 60_000 + 1;
    assert.equal(await sessionStatus(app, cookie), 401);
  }));

test('a failing handler is logged with its route and error', async () => {
  const lines = [];
  const stream = new Writable({ write(chunk, _encoding, done) {
    lines.push(...String(chunk).trim().split('\n').map((line) => JSON.parse(line)));
    done();
  } });
  await withApp(async ({ app }) => {
    const { cookie } = await signIn(app);
    const failed = await app.inject({ method: 'GET', url: '/api/library',
      headers: { cookie } });
    assert.equal(failed.statusCode, 503);
  }, { logger: { level: 'warn', stream },
    listLibraryTitles: async () => { throw new Error('synthetic library failure'); } });
  const entry = lines.find((line) => line.msg === 'Negev request failed');
  assert.ok(entry, JSON.stringify(lines));
  assert.equal(entry.route, '/api/library');
  assert.equal(entry.status, 503);
  assert.match(entry.err.message, /synthetic library failure/);
  assert.equal(JSON.stringify(lines).includes('negev-local-session='), false);
});
