import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {openAccountLedger} from '../src/auth/account-ledger.mjs';
import {buildUserApp} from '../src/web/user-app.mjs';
import {autoTrackSavedAiringRequest} from '../src/web/auto-track-request.mjs';
const origin='http://localhost:30125';
async function fixture(t,options={}){
  const dir=await mkdtemp(path.join(tmpdir(),'negev-pref-atomic-')),dbPath=path.join(dir,'db.sqlite');
  const accounts=openAccountLedger(dbPath,{now:()=>1000});
  const user=await accounts.bootstrapAdmin({username:'Owner',password:'long-owner-passphrase'});
  let app;t.after(async()=>{await app?.close();accounts.close();await rm(dir,{recursive:true,force:true})});
  app=await buildUserApp({accounts,sessionKey:randomBytes(32),publicOrigin:origin,secureCookies:false,
    now:()=>10000,submitRequest:async()=>null,readRequest:()=>null,confirmKnownTitle:async()=>true,...options});
  const login=await app.inject({method:'POST',url:'/api/login',headers:{origin},payload:{username:'Owner',password:'long-owner-passphrase'}});
  const cookie=login.headers['set-cookie'].split(';')[0];
  const session=await app.inject({method:'GET',url:'/api/session',headers:{cookie}});
  const headers={cookie,origin,'x-negev-csrf':session.json().csrfToken};
  return {accounts,app,user,dbPath,headers,patch:payload=>app.inject({method:'PATCH',url:'/api/airing/preferences',headers,payload})};
}

test('two account connections preserve independent tracking and mode intents across reopen',async t=>{
  const x=await fixture(t),other=openAccountLedger(x.dbPath);try{
  x.accounts.setAiringPreferences({userId:x.user.id,mode:'library',trackedAnidbIds:[11]});
  assert.equal(typeof x.accounts.changeAiringPreferences,'function','atomic preferences are required');
  x.accounts.changeAiringPreferences({userId:x.user.id,action:'track',anidbId:22});
  other.changeAiringPreferences({userId:x.user.id,action:'mode',mode:'custom'});
  x.accounts.changeAiringPreferences({userId:x.user.id,action:'untrack',anidbId:11});
  assert.deepEqual(other.getAiringPreferences({userId:x.user.id}),{mode:'custom',trackedAnidbIds:[22]});
  const reopened=openAccountLedger(x.dbPath);try{assert.deepEqual(reopened.getAiringPreferences({userId:x.user.id}),{mode:'custom',trackedAnidbIds:[22]})}finally{reopened.close()}
  }finally{other.close()}
});

test('authenticated mode change can finish while track validation waits without losing either change',async t=>{
  let release,started;const validating=new Promise(resolve=>started=resolve);
  const x=await fixture(t,{confirmKnownTitle:async()=>{started();return new Promise(resolve=>release=resolve)}});
  x.accounts.setAiringPreferences({userId:x.user.id,mode:'library',trackedAnidbIds:[11]});
  const pending=x.patch({action:'track',anidbId:22});
  // Ensure the route exists before waiting on its validation gate.
  const first=await Promise.race([pending,validating.then(()=>null)]);
  assert.equal(first,null,'track must reach title validation');
  const mode=await x.patch({action:'mode',mode:'all'});assert.equal(mode.statusCode,200,mode.body);
  release(true);const track=await pending;assert.equal(track.statusCode,200,track.body);
  assert.deepEqual(track.json(),{mode:'all',trackedAnidbIds:[11,22]});
});

test('legacy full-list writes cannot erase a newer tracked title',async t=>{
  const x=await fixture(t);x.accounts.setAiringPreferences({userId:x.user.id,mode:'custom',trackedAnidbIds:[11,22]});
  const legacy=await x.app.inject({method:'PUT',url:'/api/airing/preferences',headers:x.headers,payload:{mode:'all',trackedAnidbIds:[11]}});
  assert.equal(legacy.statusCode,409,legacy.body);
  assert.deepEqual(x.accounts.getAiringPreferences({userId:x.user.id}),{mode:'custom',trackedAnidbIds:[11,22]});
});

test('atomic tracking preserves account ownership, validation, idempotence and cap',async t=>{
  const x=await fixture(t,{confirmKnownTitle:async({anidbId})=>anidbId!==999});
  assert.equal((await x.app.inject({method:'PATCH',url:'/api/airing/preferences',headers:{cookie:x.headers.cookie,origin},payload:{action:'track',anidbId:22}})).statusCode,403);
  for(const payload of [{action:'track',anidbId:22,userId:999},{action:'mode',mode:'all',trackedAnidbIds:[]},{action:'untrack',anidbId:0}])assert.equal((await x.patch(payload)).statusCode,400);
  assert.equal((await x.patch({action:'track',anidbId:999})).statusCode,404);
  x.accounts.setAiringPreferences({userId:x.user.id,mode:'custom',trackedAnidbIds:Array.from({length:200},(_,i)=>i+1)});
  assert.equal((await x.patch({action:'track',anidbId:201})).statusCode,400);
  assert.equal((await x.patch({action:'track',anidbId:22})).statusCode,200,'idempotent existing track is allowed at capacity');
  assert.equal((await x.patch({action:'untrack',anidbId:22})).json().trackedAnidbIds.length,199);
});

test('automatic tracking submits an add intent and never a stale whole-list replacement',()=>{
  let called;autoTrackSavedAiringRequest({result:{requestId:1,created:true},requesterId:7,anidbId:22,
    readRequest:()=>({id:1,requesterId:7,anidbId:22,kind:'series',monitorFuture:true,status:'held'}),
    accounts:{getAiringPreferences:()=>{throw Error('must not pre-read')},setAiringPreferences:()=>{throw Error('must not replace')},changeAiringPreferences:input=>called=input}});
  assert.deepEqual(called,{userId:7,action:'track',anidbId:22});
});

test('actual authenticated Library projection preserves Chinese-production flags and rejects malformed flags',async t=>{
  let malformed=false;const x=await fixture(t,{listLibraryTitles:async()=>({state:'current_proofs',items:[
    {anidbId:11,title:'Example A',verifiedEpisodeCount:1,lastVerifiedMs:1000,chineseProduction:malformed?'yes':true},
    {anidbId:22,title:'Example B',verifiedEpisodeCount:1,lastVerifiedMs:1000,chineseProduction:false}],nextAfterAnidbId:null})});
  const read=()=>x.app.inject({method:'GET',url:'/api/library',headers:{cookie:x.headers.cookie}});
  const result=await read();assert.equal(result.statusCode,200,result.body);
  assert.deepEqual(result.json().items.map(x=>x.chineseProduction),[true,false]);
  malformed=true;assert.equal((await read()).statusCode,503);
});

test('revoking a session while title validation waits prevents the delayed preference write',async t=>{
 let release,started;const validating=new Promise(resolve=>started=resolve);
 const x=await fixture(t,{confirmKnownTitle:async()=>{started();return new Promise(resolve=>release=resolve)}});
 const pending=x.patch({action:'track',anidbId:22});await validating;
 x.accounts.revokeSessions({userId:x.user.id});release(true);
 const result=await pending;assert.equal(result.statusCode,401,result.body);
 assert.deepEqual(x.accounts.getAiringPreferences({userId:x.user.id}),{mode:'library',trackedAnidbIds:[]});
});
