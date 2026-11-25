import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {openAccountLedger} from '../src/auth/account-ledger.mjs';
import {openRequestLedger} from '../src/requests/request-ledger.mjs';
import {openFileProofLedger} from '../src/availability/file-proof-ledger.mjs';
import {createUserService} from '../src/web/user-service.mjs';
const origin='http://localhost:3000';
async function fixture(run){
 const root=await mkdtemp(path.join(os.tmpdir(),'scope-api-')),dbPath=path.join(root,'state.sqlite');let service,clock=1000,machine='synthetic-a',identityReads=0,gate;
 const accounts=openAccountLedger(dbPath);const owner=await accounts.bootstrapAdmin({username:'Owner',password:'long-owner-passphrase'});accounts.close();
 const identity=()=>Response.json({MediaContainer:{machineIdentifier:machine}});
 try{
 service=await createUserService({dbPath,shokoBaseUrl:'http://shoko:8111/',shokoApiKey:'synthetic',sessionKey:randomBytes(32),publicOrigin:origin,secureCookies:false,now:()=>clock,fileProofLifetimeMs:1800000,
 plex:{plexBaseUrl:'http://plex:32400/',plexToken:'synthetic',publicSections:{episode:[102],movie:[]},shokoMount:{appRoot:'/pure',localRoot:root},plexMount:{appRoot:'/source-pure',localRoot:root}},fetchImpl:async url=>{
 if(url.pathname==='/identity'){identityReads++;if(gate){gate.started();return new Promise(resolve=>gate.release=status=>resolve(status===200?identity():new Response(null,{status})));}return identity();}
 if(url.pathname==='/api/v3/Series/AniDB/Search')return Response.json({Total:1,List:[{ID:42,Title:'Example'}]});
 if(url.pathname==='/api/v3/Series/AniDB/42')return Response.json({ID:42,Title:'Example',Type:'TV',AirDate:'2020-01-01',EndDate:'2020-02-01',EpisodeCount:2,Restricted:false});
 if(url.pathname==='/api/v3/Series/AniDB/42/Episode')return Response.json({Total:2,List:[1001,1002].map((ID,i)=>({ID,AnimeID:42,EpisodeNumber:i+1,Type:'Episode',Title:'Episode '+i,AirDate:'2020-01-01'}))});
 return new Response(null,{status:503});}});
 await service.ensurePublicAvailabilityScope();
 const proofs=openFileProofLedger(dbPath,{positiveLifetimeMs:1800000,now:()=>clock});proofs.observe({anidbId:42,episodeId:1001,proof:{fileId:51,libraryId:102,ratingKey:500,partId:900},checkedMs:900});proofs.close();
 const login=await service.app.inject({method:'POST',url:'/api/login',headers:{origin},payload:{username:'Owner',password:'long-owner-passphrase'}});assert.equal(login.statusCode,200,login.body);const cookie=login.headers['set-cookie'].split(';')[0];
 const get=url=>service.app.inject({method:'GET',url,headers:{cookie}}),session=(await get('/api/session')).json();
 await get('/api/catalogue/search?q=Example');
 await run({service,dbPath,owner,cookie,session,get,reads:()=>identityReads,
  block(){clock+=300001;let started;const began=new Promise(resolve=>started=resolve);gate={started};return began;},
  release(status=200){gate?.release?.(status);gate=undefined;},changeMachine(){machine='synthetic-b';}});
 }finally{gate?.release?.(503);await service?.close();await rm(root,{recursive:true,force:true});}
}
async function prompt(promise){let timer;try{return await Promise.race([promise,new Promise(resolve=>timer=setTimeout(()=>resolve('blocked'),500))]);}finally{clearTimeout(timer);}}

test('expired scope does not start an identity renewal for authenticated account and raw request reads',()=>fixture(async f=>{
 const requests=openRequestLedger(f.dbPath),saved=requests.submit({requesterId:f.owner.id,requestKey:'saved',nowMs:1000,intent:{state:'ready',anidbId:42,kind:'series',monitorFuture:true,episodeIds:[1001,1002]}});requests.close();f.block();const prior=f.reads();
 const routes=['/api/session','/api/admin/users',`/api/requests/${saved.requestId}`,'/api/airing/preferences'];
 const responses=await prompt(Promise.all(routes.map(f.get)));assert.notEqual(responses,'blocked','account data must not wait for unrelated Plex identity');assert.deepEqual(responses.map(r=>r.statusCode),[200,200,200,200]);assert.equal(responses[0].json().user.username,'Owner');assert.equal(responses[1].json().items[0].username,'Owner');assert.equal(responses[2].json().id,saved.requestId);assert.equal(f.reads(),prior);
}));

test('account reads remain responsive while Library renews scope with periodic workers off',()=>fixture(async f=>{
 assert.equal((await f.get('/api/library')).json().items[0].anidbId,42);const began=f.block();let librarySettled=false;
 const library=f.get('/api/library').then(response=>{librarySettled=true;return response;});await began;
 const accounts=await prompt(Promise.all(['/api/session','/api/admin/users'].map(f.get)));assert.notEqual(accounts,'blocked','account routes must not share the Library wait');assert.deepEqual(accounts.map(r=>r.statusCode),[200,200]);assert.equal(librarySettled,false);
 f.release();const renewed=await library;assert.equal(renewed.json().items[0].anidbId,42,'a successful demand renewal preserves the Library proof');assert.equal(renewed.json().items[0].lastVerifiedMs,900,'lease renewal must not rebase proof time');
}));

test('failed availability renewal withholds Library and Watching positives while account routes stay usable',()=>fixture(async f=>{
 const requests=openRequestLedger(f.dbPath);requests.submit({requesterId:f.owner.id,requestKey:'watch',nowMs:1000,intent:{state:'ready',anidbId:42,kind:'series',monitorFuture:true,episodeIds:[1001,1002]}});requests.close();
 const began=f.block(),library=f.get('/api/library');await began;f.release(503);assert.deepEqual((await library).json().items,[]);
 const watching=(await f.get('/api/requests?view=watching')).json();assert.equal(watching.items[0].progress.publicVerifiedTargets,undefined);
 assert.equal((await f.get('/api/session')).statusCode,200);
 const proofs=openFileProofLedger(f.dbPath,{positiveLifetimeMs:1800000,now:()=>301001});try{assert.equal(proofs.getCurrent({anidbId:42,episodeId:1001}).verifiedAtMs,900,'failed lease renewal retains the original untrusted receipt');}finally{proofs.close();}
}));

test('a changed identity after idle expiry retires prior Library proof',()=>fixture(async f=>{
 const began=f.block(),library=f.get('/api/library');await began;f.changeMachine();f.release();assert.deepEqual((await library).json().items,[]);
 const proofs=openFileProofLedger(f.dbPath,{positiveLifetimeMs:1800000,now:()=>301001});try{assert.equal(proofs.getCurrent({anidbId:42,episodeId:1001}).state,'unknown');}finally{proofs.close();}
}));

for(const status of [200,503])test(`request submission renews scope before exact target filtering (identity ${status})`,()=>fixture(async f=>{
 const began=f.block();let settled=false;const submission=f.service.app.inject({method:'POST',url:'/api/requests',headers:{cookie:f.cookie,origin,'x-negev-csrf':f.session.csrfToken},payload:{anidbId:42,scope:'installment',requestKey:'new-scope'}}).then(response=>{settled=true;return response;});await began;assert.equal(settled,false);f.release(status);const result=await submission;assert.equal(result.statusCode,202,result.body);
 const requests=openRequestLedger(f.dbPath);try{assert.deepEqual(requests.getRequest(result.json().requestId).episodeIds,status===200?[1002]:[1001,1002],'only current verified evidence can remove an exact requested target');}finally{requests.close();}
}));
