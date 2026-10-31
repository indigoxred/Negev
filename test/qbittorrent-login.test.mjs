import assert from 'node:assert/strict';
import test from 'node:test';
import { loginQbittorrent } from '../src/acquisition/qbittorrent-login.mjs';

const input = { baseUrl: 'http://qbittorrent.internal:8080/', username: 'negev', password: 'private secret' };

test('logs in once using same-origin form and returns only a validated SID', async () => {
  const calls = [];
  const result = await loginQbittorrent({ ...input, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return new Response('Ok.', { status: 200, headers: { 'set-cookie': 'SID=valid_123; Path=/; HttpOnly' } });
  } });
  assert.deepEqual(result, { state: 'authenticated', sessionId: 'valid_123' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.href, 'http://qbittorrent.internal:8080/api/v2/auth/login');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Referer, 'http://qbittorrent.internal:8080/');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(new URLSearchParams(calls[0].init.body).get('password'), input.password);
});

test('failed login, forbidden host, redirect, and malformed cookies hold without retry', async () => {
  for (const response of [
    new Response('Fails.', { status: 200 }),
    new Response('Forbidden', { status: 403 }),
    new Response(null, { status: 302, headers: { location: '/login' } }),
    new Response('Ok.', { status: 200, headers: { 'set-cookie': 'SID=bad; SID=evil; Path=/' } }),
  ]) {
    let calls = 0;
    const result = await loginQbittorrent({ ...input, fetchImpl: async () => { calls++; return response; } });
    assert.equal(result.state, 'held');
    assert.equal(calls, 1);
    assert.equal('sessionId' in result, false);
  }
});

test('invalid inputs and network errors cannot authenticate', async () => {
  for (const baseUrl of ['file:///tmp/qbit', 'http://name:pass@qbit/', 'http://qbit/path',
    'http://qbit/?x=1']) {
    await assert.rejects(() => loginQbittorrent({ ...input, baseUrl,
      fetchImpl: async () => { throw Error('must not call'); } }), TypeError);
  }
  assert.deepEqual(await loginQbittorrent({ ...input, fetchImpl: async () => {
    throw Error('private diagnostic detail');
  } }), { state: 'held', reason: 'authentication_unavailable' });
});
