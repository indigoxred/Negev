import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { buildUserApp } from '../src/web/user-app.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { createReleasePreviews } from '../src/requests/release-previews.mjs';

const deferred = () => Promise.withResolvers();
async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-preview-overlap-'));
  const requests = openRequestLedger(path.join(dir, 'db.sqlite'));
  t.after(async () => { requests.close(); await rm(dir, { recursive: true, force: true }); });
  const gates = [deferred(), deferred()], started = [deferred(), deferred()];
  const calls = [0, 0], wakes = [];
  let clock = 1000;
  const intent = { state: 'ready', anidbId: 123, kind: 'series', title: 'Example', episodeIds: [1, 2], monitorFuture: true };
  const input = { requesterId: 7, anidbId: 123, scope: 'installment', requestKey: 'review' };
  const sessions = createReleasePreviews({ requests, now: () => clock, wake: id => wakes.push(id),
    prepare: async input => ({ state: 'prepared', submission: { ...input, commandKey: 'exact', intent, nowMs: clock } }),
    selectionOptions: {
      discoverCandidates: async () => ({ state: 'candidates', releaseState: 'airing', items: ['Alpha', 'Beta'].map((guid, i) => ({ guid, indexerId: 1, title: `[Group] Example - 0${i + 1} [1080p]`, size: 100, seeders: 10 })) }),
      previewCandidate: async ({ candidate }) => {
        const i = candidate.guid === 'Alpha' ? 0 : 1;
        calls[i]++; started[i].resolve(); await gates[i].promise;
        return { state: 'preflight', torrentHash: String(i + 1).repeat(40), episodeIds: [i + 1], files: [{ name: candidate.guid + '.mkv', size: 100, episodeIds: [i + 1] }] };
      },
      readPublicCoverage: async () => ({ availableEpisodeIds: [], uncertainEpisodeIds: [] }),
      loadDetail: async () => ({ state: 'details', kind: 'series', endDate: null, startDate: '2026-01-01' }),
    },
  });
  const opened = await sessions.open(input), id = sessions.access(opened.previewId, 7);
  const found = await sessions.selection.search(id);
  const tokens = ['Alpha', 'Beta'].map(guid => found.items.find(item => item.guid === guid).token);
  const command = body => sessions.command(opened.previewId, 7, body);
  const inspect = i => command({ action: 'inspect', token: tokens[i] });
  const choose = (i, revision = 1) => command({ action: 'choose', token: tokens[i], revision });
  const assertUnsaved = () => {
    assert.equal(requests.listRequests({ requesterId: 7 }).items.length, 0);
    assert.deepEqual(requests.listActiveAirings(), []); assert.deepEqual(wakes, []);
  };
  return { sessions, requests, opened, id, tokens, gates, started, calls, wakes, command, inspect, choose, assertUnsaved, expire: () => { clock += 600001; } };
}

function evidence(result, name, episode) {
  assert.equal(result.state, 'preflight');
  assert.equal(result.torrentHash, String(episode).repeat(40));
  assert.deepEqual(result.episodeIds, [episode]);
  assert.equal(result.files[0].name, name + '.mkv');
}

test('W07 coordinator keeps concurrent distinct-release inspection evidence separate', async t => {
  const x = await fixture(t);
  const alpha = x.inspect(0); await x.started[0].promise;
  const beta = x.inspect(1);
  x.gates.forEach(gate => gate.resolve());
  const [a, b] = await Promise.all([alpha, beta]);
  evidence(a, 'Alpha', 1); evidence(b, 'Beta', 2);
  assert.deepEqual(x.calls, [1, 1]); x.assertUnsaved();
});

test('same receipt inspections coalesce preflight without saving a draft', async t => {
  const x = await fixture(t);
  const a = x.inspect(0); await x.started[0].promise;
  const b = x.inspect(0); x.gates[0].resolve();
  const results = await Promise.all([a, b]); results.forEach(result => evidence(result, 'Alpha', 1));
  assert.deepEqual(x.calls, [1, 0]); x.assertUnsaved();
});

for (const inspectFirst of [true, false]) test(`inspection and choice keep their own results (inspect first: ${inspectFirst})`, async t => {
  const x = await fixture(t);
  const first = inspectFirst ? x.inspect(0) : x.choose(1);
  await x.started[inspectFirst ? 0 : 1].promise;
  const second = inspectFirst ? x.choose(1) : x.inspect(0);
  x.gates.forEach(gate => gate.resolve());
  const [a, b] = await Promise.all([first, second]);
  evidence(inspectFirst ? a : b, 'Alpha', 1);
  const saved = inspectFirst ? b : a;
  assert.equal(saved.state, 'updated'); assert.ok(saved.requestId);
  const control = x.requests.getReleaseControl(saved.requestId, 1000);
  assert.equal(control.selection.candidate.guid, 'Beta'); evidence(control.selection.preview, 'Beta', 2);
  assert.equal(x.requests.listRequests({ requesterId: 7 }).items.length, 1);
  assert.deepEqual(x.wakes, [saved.requestId]);
});

test('identical choices coalesce but another token or revision cannot borrow their success', async t => {
  const x = await fixture(t);
  const a = x.choose(0); await x.started[0].promise;
  const same = x.choose(0), other = x.choose(1), stale = x.choose(0, 0);
  x.gates.forEach(gate => gate.resolve());
  const [saved, repeated, conflicting, revised] = await Promise.all([a, same, other, stale]);
  assert.equal(repeated.requestId, saved.requestId);
  assert.equal(conflicting.state, 'held'); assert.equal(revised.state, 'held');
  assert.equal(conflicting.requestId, undefined); assert.equal(revised.requestId, undefined);
  assert.equal(x.requests.getReleaseControl(saved.requestId, 1000).selection.candidate.guid, 'Alpha');
  assert.deepEqual(x.calls, [1, 0]); assert.deepEqual(x.wakes, [saved.requestId]);
});

test('a mode change during inspection keeps revisions authoritative and creates no request', async t => {
  const x = await fixture(t);
  const inspecting = x.inspect(0); await x.started[0].promise;
  const begun = x.command({ action: 'begin', mode: 'auto', revision: 1 });
  x.gates[0].resolve(); const [result, changed] = await Promise.all([inspecting, begun]);
  evidence(result, 'Alpha', 1); assert.equal(changed.state, 'updated');
  assert.equal(changed.control.revision, 2); assert.equal(changed.control.mode, 'auto');
  const stale = await x.command({ action: 'begin', mode: 'manual', revision: 1 });
  assert.equal(stale.reason, 'stale_release_selection');
  assert.equal(x.sessions.selection.snapshot(x.id).mode, 'auto'); x.assertUnsaved();
});

test('expired and wrong-user access cannot reuse an in-flight inspection', async t => {
  const x = await fixture(t);
  const inspecting = x.inspect(0); await x.started[0].promise;
  const wrongUser = await x.sessions.command(x.opened.previewId, 8, { action: 'inspect', token: x.tokens[0] });
  assert.equal(wrongUser.reason, 'release_preview_expired');
  x.expire(); assert.equal(x.sessions.access(x.opened.previewId, 7), null);
  const expired = x.inspect(0); x.gates[0].resolve();
  const results = await Promise.all([inspecting, expired]);
  results.forEach(result => assert.equal(result.reason, 'release_preview_expired'));
  x.assertUnsaved();
});

test('a foreign receipt cannot borrow pending inspection evidence', async t => {
  const x = await fixture(t);
  const inspecting = x.inspect(0); await x.started[0].promise;
  const other = await x.sessions.open({ requesterId: 7, anidbId: 123, scope: 'installment', requestKey: 'other' });
  const otherId = x.sessions.access(other.previewId, 7);
  const found = await x.sessions.selection.search(otherId);
  const foreign = x.command({ action: 'inspect', token: found.items[0].token });
  x.gates[0].resolve();
  const [result, denied] = await Promise.all([inspecting, foreign]);
  evidence(result, 'Alpha', 1); assert.equal(denied.reason, 'release_search_expired');
  x.assertUnsaved();
});

test('a pending choice denies expired access and cannot commit after its deadline', async t => {
  const x = await fixture(t);
  const choosing = x.choose(0); await x.started[0].promise;
  x.expire(); assert.equal(x.sessions.access(x.opened.previewId, 7), null);
  const denied = await x.choose(0); assert.equal(denied.reason, 'release_preview_expired');
  x.gates[0].resolve();
  assert.equal((await choosing).reason, 'release_preview_expired'); x.assertUnsaved();
});

test('rejected conflicting mutations leave the pending owner intact and a failed choice can retry', async t => {
  const x = await fixture(t);
  const choosing = x.choose(0, 0); await x.started[0].promise;
  const conflict = await x.command({ action: 'begin', mode: 'auto', revision: 1 });
  assert.equal(conflict.state, 'held'); assert.equal(conflict.requestId, undefined);
  const duplicate = x.choose(0, 0);
  x.gates[0].resolve();
  const results = await Promise.all([choosing, duplicate]);
  results.forEach(result => assert.equal(result.reason, 'stale_release_selection'));
  assert.equal(x.sessions.selection.snapshot(x.id).revision, 1); x.assertUnsaved();
  const saved = await x.choose(0);
  assert.equal(saved.state, 'updated'); assert.ok(saved.requestId);
  assert.equal(x.requests.getReleaseControl(saved.requestId, 1000).selection.candidate.guid, 'Alpha');
  assert.deepEqual(x.calls, [1, 0]); assert.deepEqual(x.wakes, [saved.requestId]);
});

test('inspection and choosing the same receipt share only preflight and return distinct operation results', async t => {
  const x = await fixture(t);
  const inspecting = x.inspect(0); await x.started[0].promise;
  const choosing = x.choose(0); x.gates[0].resolve();
  const [inspected, saved] = await Promise.all([inspecting, choosing]);
  evidence(inspected, 'Alpha', 1); assert.equal(saved.state, 'updated'); assert.ok(saved.requestId);
  assert.equal(x.requests.getReleaseControl(saved.requestId, 1000).selection.candidate.guid, 'Alpha');
  assert.deepEqual(x.calls, [1, 0]); assert.deepEqual(x.wakes, [saved.requestId]);
});

test('authenticated HTTP overlapping inspect commands return separate evidence before choosing Beta', async t => {
  const x = await fixture(t);
  const user = { id: 7, username: 'Member', role: 'member', adultAllowed: true, sessionVersion: 1 };
  const accounts = { authenticate: async () => user, getSessionUser: () => user,
    registerInvite: async () => null, createInvite: () => null, revokeSessions: () => false };
  const origin = 'http://localhost:3000';
  const app = await buildUserApp({ accounts, sessionKey: randomBytes(32), publicOrigin: origin, secureCookies: false,
    submitRequest: async () => { throw new Error('ordinary submission must not run'); },
    readRequest: id => x.requests.getRequest(id), releasePreviews: x.sessions, releaseSelection: x.sessions.selection,
    confirmKnownTitle: async () => true,
    loadDetail: async () => ({ state: 'details', anidbId: 123, title: 'Example', kind: 'series', restricted: false }),
  });
  t.after(() => app.close());
  const login = await app.inject({ method: 'POST', url: '/api/login', headers: { origin },
    payload: { username: 'Member', password: 'long-passphrase' } });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = login.headers['set-cookie'].split(';')[0];
  const session = await app.inject({ url: '/api/session', headers: { cookie } });
  assert.equal(session.statusCode, 200, session.body);
  const headers = { cookie, origin, 'x-negev-csrf': session.json().csrfToken };
  const base = '/api/release-previews/' + x.opened.previewId;
  const found = await app.inject({ url: base + '/releases', headers: { cookie } });
  assert.equal(found.statusCode, 200, found.body);
  const alphaToken = found.json().items.find(item => item.guid === 'Alpha').token;
  const betaToken = found.json().items.find(item => item.guid === 'Beta').token;
  assert.notEqual(alphaToken, betaToken);
  const post = payload => app.inject({ method: 'POST', url: base + '/release-choice', headers, payload }).then(result => result);
  const alpha = post({ action: 'inspect', token: alphaToken, revision: 1 });
  await Promise.race([x.started[0].promise, alpha.then(response => { throw new Error('Alpha inspection returned early: ' + response.body); })]);
  const beta = post({ action: 'inspect', token: betaToken, revision: 1 });
  let timer;
  try {
    // Both HTTP handlers must enter their own inspection before either finishes.
    await Promise.race([x.started[1].promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Beta inspection was blocked by Alpha')), 3000);
    })]);
  } finally { clearTimeout(timer); x.gates.forEach(gate => gate.resolve()); }
  const [a, b] = await Promise.all([alpha, beta]);
  assert.equal(a.statusCode, 200, a.body); assert.equal(b.statusCode, 200, b.body);
  evidence(a.json(), 'Alpha', 1); evidence(b.json(), 'Beta', 2);
  assert.equal(a.json().requestId, undefined); assert.equal(b.json().requestId, undefined);
  assert.deepEqual(x.calls, [1, 1]); x.assertUnsaved();
  const chosen = await post({ action: 'choose', token: betaToken, revision: 1 });
  assert.equal(chosen.statusCode, 200, chosen.body);
  assert.equal(chosen.json().state, 'updated'); assert.ok(chosen.json().requestId);
  const control = x.requests.getReleaseControl(chosen.json().requestId, 1000);
  assert.equal(control.selection.candidate.guid, 'Beta'); evidence(control.selection.preview, 'Beta', 2);
  assert.equal(x.requests.listRequests({ requesterId: 7 }).items.length, 1);
  assert.deepEqual(x.calls, [1, 1]); assert.deepEqual(x.wakes, [chosen.json().requestId]);
});

test('closing during inspection retains its context until the read settles, then frees it',async t=>{
 const x=await fixture(t),pending=x.inspect(0);await x.started[0].promise;
 assert.equal(x.sessions.close(x.opened.previewId,7).state,'closed');assert.equal(x.sessions.access(x.opened.previewId,7),null);
 assert.ok(x.sessions.readRequest(x.id));x.gates[0].resolve();await pending;
 assert.equal(x.sessions.readRequest(x.id),null);x.assertUnsaved();
});
test('closing after an explicit Grab began retains its one committed receipt',async t=>{
 const x=await fixture(t),pending=x.choose(0);await x.started[0].promise;
 assert.equal(x.sessions.close(x.opened.previewId,7).state,'closed');x.gates[0].resolve();const result=await pending;
 assert.ok(result.requestId,JSON.stringify(result));assert.equal(x.requests.countRequests(),1);assert.equal(x.wakes.length,1);
 const replay=await x.choose(0);assert.equal(replay.requestId,result.requestId);
 assert.equal((await x.sessions.command(x.opened.previewId,8,{action:'choose',token:x.tokens[0],revision:1})).reason,'release_preview_expired');
 x.requests.cancelRequest({requesterId:7,requestId:result.requestId,nowMs:2000});assert.equal((await x.choose(0)).reason,'request_cancelled');
});

test('browser GET inspection retains its preview context until the read settles after close', async t => {
  const x = await fixture(t);
  const user = { id: 7, username: 'Member', role: 'member', adultAllowed: true, sessionVersion: 1 };
  const accounts = { authenticate: async () => user, getSessionUser: () => user,
    registerInvite: async () => null, createInvite: () => null, revokeSessions: () => false };
  const origin = 'http://localhost:3000';
  const app = await buildUserApp({ accounts, sessionKey: randomBytes(32), publicOrigin: origin, secureCookies: false,
    submitRequest: async () => { throw new Error('ordinary submission must not run'); },
    readRequest: id => x.requests.getRequest(id), releasePreviews: x.sessions, releaseSelection: x.sessions.selection,
    confirmKnownTitle: async () => true,
    loadDetail: async () => ({ state: 'details', anidbId: 123, title: 'Example', kind: 'series', restricted: false }),
  });
  t.after(() => app.close());
  const login = await app.inject({ method: 'POST', url: '/api/login', headers: { origin },
    payload: { username: 'Member', password: 'long-passphrase' } });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = login.headers['set-cookie'].split(';')[0];
  const session = await app.inject({ url: '/api/session', headers: { cookie } });
  assert.equal(session.statusCode, 200, session.body);
  const headers = { cookie, origin, 'x-negev-csrf': session.json().csrfToken };
  const base = '/api/release-previews/' + x.opened.previewId;

 const inspecting=app.inject({url:base+'/release-inspection?token='+x.tokens[0],headers:{cookie}}).then(response=>response);
 await x.started[0].promise;
 try{x.sessions.close(x.opened.previewId,7);assert.ok(x.sessions.readRequest(x.id),'GET provider read must retain its private context');}
 finally{x.gates[0].resolve();await inspecting;}
 assert.equal(x.sessions.readRequest(x.id),null);x.assertUnsaved();
});
