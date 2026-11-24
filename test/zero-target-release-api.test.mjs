import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openAccountLedger } from '../src/auth/account-ledger.mjs';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { createHeldRequestSubmitter } from '../src/requests/submit-held-request.mjs';
import { buildUserApp } from '../src/web/user-app.mjs';

test('authenticated zero-target non-Auto API rejects without saving an Auto watch', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-empty-manual-api-'));
  const accounts = openAccountLedger(path.join(root, 'accounts.sqlite'));
  const owner = await accounts.bootstrapAdmin({ username: 'Owner', password: 'long-owner-passphrase' });
  const ledger = openRequestLedger(path.join(root, 'requests.sqlite'));
  const detail = { state: 'details', anidbId: 42, title: 'Airing series',
    kind: 'series', restricted: false, complete: true, page: 1, total: 1,
    nextPage: null, airDate: '2026-11-01', endDate: null, episodeCount: 12,
    episodes: [{ id: 99, number: 1, type: 'Episode', title: 'First', airDate: '2026-11-01' }] };
  const submit = createHeldRequestSubmitter({ ledger, authorizeRequester: () => ({ active: true, adultAllowed: true }),
    confirmKnownTitle: async () => true, loadDetail: async () => detail, recentlyAvailable: () => true,
    now: () => 1000, today: () => '2026-11-03' });
  const origin = 'http://localhost:3000';
  const app = await buildUserApp({ accounts, submitRequest: submit, readRequest: id => ledger.getRequest(id),
    releaseSelection: {}, sessionKey: randomBytes(32), publicOrigin: origin, secureCookies: false });
  try {
    const login = await app.inject({ method: 'POST', url: '/api/login', headers: { origin }, payload: { username: 'Owner', password: 'long-owner-passphrase' } });
    const cookie = login.headers['set-cookie'].split(';')[0];
    const session = await app.inject({ method: 'GET', url: '/api/session', headers: { cookie } });
    const headers = { cookie, origin, 'x-negev-csrf': session.json().csrfToken };
    for (const releaseMode of ['manual', 'auto_review']) {
      const result = await app.inject({ method: 'POST', url: '/api/requests', headers,
        payload: { anidbId: 42, scope: 'installment', requestKey: releaseMode, releaseMode } });
      assert.equal(result.statusCode, 409, result.body);
      assert.equal(result.json().reason, 'release_selection_requires_targets');
      assert.deepEqual(ledger.listRequests({ requesterId: owner.id }).items, []);
    }
    const auto = await app.inject({ method: 'POST', url: '/api/requests', headers,
      payload: { anidbId: 42, scope: 'installment', requestKey: 'auto', releaseMode: 'auto' } });
    assert.equal(auto.statusCode, 202, auto.body);
    assert.equal(ledger.getRequest(auto.json().requestId).monitorFuture, true);
  } finally { await app.close(); ledger.close(); accounts.close(); await rm(root, { recursive: true, force: true }); }
});
