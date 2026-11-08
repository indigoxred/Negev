import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openAccountLedger } from '../src/auth/account-ledger.mjs';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { createUserService } from '../src/web/user-service.mjs';

const origin = 'http://localhost:3000';

test('cold title is durably queued without targets, then becomes one exact request',
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'negev-cold-title-service-'));
    const dbPath = path.join(dir, 'negev.sqlite');
    let clock = 1_000;
    let ready = false;
    let slow = false;
    const accounts = openAccountLedger(dbPath, { now: () => clock });
    await accounts.bootstrapAdmin({ username: 'Owner',
      password: 'long-owner-passphrase' });
    accounts.close();
    const fetchImpl = async (url) => {
      const route = new URL(url).pathname;
      if (route === '/api/v3/Series/AniDB/Search') {
        return Response.json({ Total: 1, List: [
          { ID: 4158, Title: 'Pale Cocoon' }] });
      }
      if (route === '/api/v3/Series/AniDB/4158') {
        if (!ready && slow) await new Promise((resolve) => setTimeout(resolve, 3_500));
        return ready ? Response.json({ ID: 4158, Title: 'Pale Cocoon',
          Type: 'Movie', AirDate: '2005-11-01', EndDate: '2005-11-01',
          EpisodeCount: 1, Restricted: false }) :
          new Response(null, { status: 404 });
      }
      if (route === '/api/v3/Series/AniDB/4158/Episode') {
        return Response.json({ Total: 1, List: [
          { ID: 777, AnimeID: 4158, EpisodeNumber: 1,
            Type: 'Episode', Title: 'Film', AirDate: '2005-11-01' }] });
      }
      if (url.origin === 'https://animap.id') {
        return new Response(null, { status: 503 });
      }
      throw new Error(`Unexpected route ${route}`);
    };
    const service = await createUserService({ dbPath,
      shokoBaseUrl: 'http://shoko.internal:8111', shokoApiKey: 'synthetic',
      sessionKey: randomBytes(32), publicOrigin: origin,
      secureCookies: false, fetchImpl, now: () => clock,
      today: () => '2026-11-09' });
    try {
      const login = await service.app.inject({ method: 'POST', url: '/api/login',
        headers: { origin }, payload: { username: 'Owner',
          password: 'long-owner-passphrase' } });
      assert.equal(login.statusCode, 200, login.body);
      const cookie = login.headers['set-cookie'].split(';')[0];
      const session = await service.app.inject({ method: 'GET',
        url: '/api/session', headers: { cookie } });
      const headers = { origin, cookie,
        'x-negev-csrf': session.json().csrfToken };
      const search = await service.app.inject({ method: 'GET',
        url: '/api/catalogue/search?q=Pale%20Cocoon', headers: { cookie } });
      assert.equal(search.statusCode, 200, search.body);
      slow = true;
      const started = performance.now();
      const request = await service.app.inject({ method: 'POST',
        url: '/api/requests', headers,
        payload: { anidbId: 4158, scope: 'installment',
          requestKey: 'cold-one' } });
      assert.equal(request.statusCode, 202, request.body);
      assert.equal(request.json().state, 'pending');
      assert.ok(performance.now() - started < 5_000,
        'cold request should save inside the five-second UI budget');
      slow = false;
      await new Promise((resolve) => setTimeout(resolve, 550));
      const history = await service.app.inject({ method: 'GET',
        url: '/api/request-preparations', headers: { cookie } });
      assert.equal(history.statusCode, 200, history.body);
      assert.equal(history.json().items[0].title, 'Pale Cocoon');
      const exact = openRequestLedger(dbPath);
      try {
        assert.equal(exact.countRequests(), 0);
        assert.equal(exact.countTargets(), 0);
        assert.equal((await service.tickPendingTitle()).state, 'pending');
        ready = true;
        clock = 31_000;
        const resolved = await service.tickPendingTitle();
        assert.equal(resolved.state, 'resolved');
        assert.deepEqual(exact.getRequest(resolved.requestId).episodeIds,
          [777]);
        assert.equal(exact.countRequests(), 1);
        const after = await service.app.inject({ method: 'GET',
          url: '/api/request-preparations', headers: { cookie } });
        assert.deepEqual(after.json().items, []);
      } finally { exact.close(); }
    } finally { await service.close(); await rm(dir, {
      recursive: true, force: true }); }
  });
