import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openAccountLedger } from '../src/auth/account-ledger.mjs';
import { deleteAccount } from '../src/auth/delete-account.mjs';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { openPendingTitleLedger } from '../src/requests/pending-title-ledger.mjs';
import { openParentWatchLedger } from '../src/requests/parent-watch-ledger.mjs';
import { openAcquisitionLedger } from '../src/acquisition/acquisition-ledger.mjs';
import { buildUserApp } from '../src/web/user-app.mjs';

const origin = 'http://localhost:3000';
const ownerPassword = 'long-owner-passphrase';

// A database with an admin, a member and three of the member's requests:
// one plain, one with child rows, and one whose download already started.
async function withData(run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-delete-account-'));
  const dbPath = path.join(dir, 'negev.sqlite');
  const accounts = openAccountLedger(dbPath, { now: () => 1_000 });
  let acquisitions;
  try {
    const owner = await accounts.bootstrapAdmin({ username: 'Owner', password: ownerPassword });
    const { code } = accounts.createInvite({ adminUserId: owner.id, expiresMs: 900_000 });
    const member = await accounts.registerInvite({ code, username: 'Friend',
      password: 'long-member-passphrase' });
    openRequestLedger(dbPath).close();
    openPendingTitleLedger(dbPath).close();
    openParentWatchLedger(dbPath).close();
    acquisitions = openAcquisitionLedger(dbPath);
    const db = new DatabaseSync(dbPath);
    const addRequest = (requesterId, key) => Number(db.prepare(`INSERT INTO requests
      (requester_id,request_key,anidb_id,kind,episode_key,monitor_future,created_ms,status,reason)
      VALUES (?,?,100,'series','all',1,1000,'held','saved')`).run(requesterId, key).lastInsertRowid);
    const plain = addRequest(member.id, 'plain');
    const withChildren = addRequest(member.id, 'children');
    const started = addRequest(member.id, 'started');
    const ownerRequest = addRequest(owner.id, 'owner');
    const target = Number(db.prepare(`INSERT INTO targets (anidb_id,episode_id,status,reason)
      VALUES (100,1,'held','saved')`).run().lastInsertRowid);
    db.prepare('INSERT INTO request_targets (request_id,target_id) VALUES (?,?)').run(withChildren, target);
    db.prepare('INSERT INTO request_targets (request_id,target_id) VALUES (?,?)').run(ownerRequest, target);
    db.prepare(`INSERT INTO rss_watch_timing (request_id,next_metadata_ms,feed_interval_ms)
      VALUES (?,0,60000)`).run(withChildren);
    db.prepare('INSERT INTO request_targets (request_id,target_id) VALUES (?,?)').run(started, target);
    const candidate = { indexerId: 7, guid: 'fixture-started-release' };
    const hash = 'a'.repeat(40);
    const attemptId = acquisitions.reserve({ requestId: started, candidate,
      episodeIds: [1], nowMs: 1000 }).attemptId;
    acquisitions.bindPreparedTorrent({ attemptId, candidate, hash, nowMs: 1001 });
    acquisitions.beginDispatch({ attemptId, nowMs: 1002 });
    acquisitions.recordTorrent({ attemptId, hash, nowMs: 1003 });
    acquisitions.beginStart({ attemptId, hash, manifestDigest: 'b'.repeat(64), nowMs: 1004 });
    db.prepare(`INSERT INTO pending_title_intents (requester_id,request_key,anidb_id,title,
      created_ms,state,next_due_ms) VALUES (?,'p',200,'Pending',1000,'pending',0)`).run(member.id);
    db.prepare(`INSERT INTO parent_watches (tvdb_id,requester_id,source_series_id,enabled,
      created_ms,updated_ms) VALUES (77,?,5,1,1000,1000)`).run(member.id);
    db.prepare(`INSERT INTO parent_watch_installments (anidb_id,tvdb_id,request_id,recorded_ms)
      VALUES (300,77,?,1000)`).run(withChildren);
    db.close();
    await run({ dbPath, accounts, owner, member, ids: { plain, withChildren, started, ownerRequest } });
  } finally {
    acquisitions?.close();
    accounts.close();
    await rm(dir, { recursive: true, force: true });
  }
}
const count = (dbPath, sql, ...params) => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return db.prepare(sql).get(...params).n; } finally { db.close(); }
};

test('deleting an account removes its requests and keeps started downloads as closed history', () =>
  withData(async ({ dbPath, accounts, owner, member, ids }) => {
    assert.equal(accounts.setDisabled({ adminUserId: owner.id, userId: member.id, disabled: true }).state,
      'updated');
    const result = deleteAccount(dbPath, { adminUserId: owner.id, userId: member.id });
    assert.deepEqual(result, { state: 'deleted', userId: member.id, username: 'Friend',
      deletedRequests: 2, keptStartedRequests: 1 });
    assert.equal(count(dbPath, 'SELECT COUNT(*) n FROM users WHERE id=?', member.id), 0);
    assert.equal(count(dbPath, 'SELECT COUNT(*) n FROM requests WHERE id IN (?,?)',
      ids.plain, ids.withChildren), 0);
    assert.equal(count(dbPath, 'SELECT COUNT(*) n FROM request_targets WHERE request_id=?',
      ids.withChildren), 0);
    assert.equal(count(dbPath, 'SELECT COUNT(*) n FROM rss_watch_timing'), 0);
    assert.equal(count(dbPath, 'SELECT COUNT(*) n FROM requests WHERE id=? AND watch_closed=1',
      ids.started), 1, 'the started request stays and stops watching');
    assert.equal(count(dbPath, 'SELECT COUNT(*) n FROM acquisition_attempts'), 1);
    assert.equal(count(dbPath, 'SELECT COUNT(*) n FROM pending_title_intents'), 0);
    assert.equal(count(dbPath, 'SELECT COUNT(*) n FROM parent_watches'), 0);
    assert.equal(count(dbPath, 'SELECT COUNT(*) n FROM parent_watch_installments'), 0);
    assert.equal(count(dbPath, 'SELECT COUNT(*) n FROM requests WHERE id=?', ids.ownerRequest), 1,
      'other accounts keep their requests');
    assert.equal(count(dbPath, 'SELECT COUNT(*) n FROM request_targets WHERE request_id=?',
      ids.ownerRequest), 1);
    const listed = accounts.listInvites({ adminUserId: owner.id }).items;
    assert.equal(listed[0].status, 'used');
    assert.equal(listed[0].usedBy, null, 'the used invitation no longer names the deleted account');
    assert.equal(await accounts.authenticate({ username: 'Friend',
      password: 'long-member-passphrase' }), null);
  }));

test('an account must be disabled first, and admins cannot delete themselves', () =>
  withData(async ({ dbPath, owner, member }) => {
    assert.deepEqual(deleteAccount(dbPath, { adminUserId: owner.id, userId: member.id }),
      { state: 'held', reason: 'disable_first' });
    assert.deepEqual(deleteAccount(dbPath, { adminUserId: owner.id, userId: owner.id }),
      { state: 'held', reason: 'cannot_delete_self' });
    assert.deepEqual(deleteAccount(dbPath, { adminUserId: member.id, userId: owner.id }),
      { state: 'held', reason: 'admin_required' });
    assert.deepEqual(deleteAccount(dbPath, { adminUserId: owner.id, userId: 999 }),
      { state: 'held', reason: 'user_unavailable' });
    assert.equal(count(dbPath, 'SELECT COUNT(*) n FROM requests'), 4, 'nothing was removed');
  }));

test('the admin route deletes a disabled account', () =>
  withData(async ({ dbPath, accounts, owner, member }) => {
    const app = await buildUserApp({ accounts, sessionKey: randomBytes(32),
      publicOrigin: origin, secureCookies: false,
      submitRequest: async () => null, readRequest: () => null,
      deleteAccount: (input) => deleteAccount(dbPath, input) });
    try {
      const login = await app.inject({ method: 'POST', url: '/api/login', headers: { origin },
        payload: { username: 'Owner', password: ownerPassword } });
      const cookie = login.headers['set-cookie'].split(';')[0];
      const session = await app.inject({ method: 'GET', url: '/api/session', headers: { cookie } });
      const headers = { cookie: session.headers['set-cookie']?.split(';')[0] ?? cookie, origin,
        'x-negev-csrf': session.json().csrfToken };
      const early = await app.inject({ method: 'POST', url: `/api/admin/users/${member.id}/delete`,
        headers, payload: {} });
      assert.equal(early.statusCode, 409);
      assert.equal(early.json().reason, 'disable_first');
      accounts.setDisabled({ adminUserId: owner.id, userId: member.id, disabled: true });
      const done = await app.inject({ method: 'POST', url: `/api/admin/users/${member.id}/delete`,
        headers, payload: {} });
      assert.equal(done.statusCode, 200, done.body);
      assert.equal(done.json().deletedRequests, 2);
      const users = await app.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie: headers.cookie } });
      assert.deepEqual(users.json().items.map((user) => user.username), ['Owner']);
    } finally { await app.close(); }
  }));

for(const target of ['plain','started'])test('settled dispatch refusal permits account deletion with '+target+' history',()=>withData(async({dbPath,accounts,owner,member,ids})=>{
 let ledger=openAcquisitionLedger(dbPath);
 try{
  // Use an existing target on either request; the earlier started attempt has
  // an inactive claim after a definitive refusal on this independent candidate.
  const db=new DatabaseSync(dbPath);try{db.prepare('INSERT OR IGNORE INTO request_targets(request_id,target_id) SELECT ?,id FROM targets WHERE episode_id=1').run(ids[target]);db.prepare('UPDATE acquisition_target_claims SET active=0').run();}finally{db.close()}
  const candidate={indexerId:7,guid:'refused-'+target},hash='c'.repeat(40);
  const reserved=ledger.reserve({requestId:ids[target],candidate,episodeIds:[1],nowMs:2000});assert.ok(reserved.attemptId,JSON.stringify(reserved));
  ledger.bindPreparedTorrent({attemptId:reserved.attemptId,candidate,hash,nowMs:2001});ledger.beginDispatch({attemptId:reserved.attemptId,nowMs:2002});
  assert.equal(ledger.rejectDispatch({attemptId:reserved.attemptId,candidate,hash,nowMs:2003,httpStatus:403}).state,'dispatch_rejected');
  ledger.close();ledger=openAcquisitionLedger(dbPath);
  accounts.setDisabled({adminUserId:owner.id,userId:member.id,disabled:true});
  const result=deleteAccount(dbPath,{adminUserId:owner.id,userId:member.id});assert.equal(result.state,'deleted',JSON.stringify(result));
  if(target==='started')assert.equal(count(dbPath,'SELECT count(*) AS n FROM acquisition_dispatch_refusals'),1);
 }finally{ledger.close()}
}));

for(const fault of ['uncertain','wrong_hash','no_release','active_claim'])test('account deletion retains '+fault+' dispatch guard',()=>withData(async({dbPath,accounts,owner,member,ids})=>{
 const ledger=openAcquisitionLedger(dbPath);try{
  const db=new DatabaseSync(dbPath);try{db.prepare('UPDATE acquisition_target_claims SET active=0').run();}finally{db.close()}
  const candidate={indexerId:7,guid:'guard-'+fault},hash='d'.repeat(40);
  const id=ledger.reserve({requestId:ids.withChildren,candidate,episodeIds:[1],nowMs:2000}).attemptId;
  ledger.bindPreparedTorrent({attemptId:id,candidate,hash,nowMs:2001});ledger.beginDispatch({attemptId:id,nowMs:2002});
  if(fault!=='uncertain')ledger.rejectDispatch({attemptId:id,candidate,hash,nowMs:2003,httpStatus:403});
  const alter=new DatabaseSync(dbPath);try{
   if(fault==='wrong_hash')alter.prepare('UPDATE acquisition_dispatch_refusals SET torrent_hash=? WHERE attempt_id=?').run('e'.repeat(40),id);
   if(fault==='no_release')alter.prepare('DELETE FROM acquisition_releases WHERE attempt_id=?').run(id);
   if(fault==='active_claim')alter.prepare('UPDATE acquisition_target_claims SET active=1 WHERE attempt_id=?').run(id);
  }finally{alter.close()}
  accounts.setDisabled({adminUserId:owner.id,userId:member.id,disabled:true});
  assert.equal(deleteAccount(dbPath,{adminUserId:owner.id,userId:member.id}).reason,'acquisition_unsettled');
  assert.equal(count(dbPath,'SELECT count(*) n FROM users WHERE id=?',member.id),1);
 }finally{ledger.close()}
}));
