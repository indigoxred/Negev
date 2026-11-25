import{openRequestLedger}from'../src/requests/request-ledger.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';import {randomBytes} from 'node:crypto';
import {openDirectAvailabilityQueue} from '../src/availability/direct-availability-queue.mjs';
import {createUserService} from '../src/web/user-service.mjs';
import {openAccountLedger} from '../src/auth/account-ledger.mjs';
import {DatabaseSync} from 'node:sqlite';
for(const total of [1,2])test(`disabling public observer preserves the exact ${total}-episode HTTP request scope despite old direct receipts`,async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'observer-off-')),dbPath=path.join(root,'state.sqlite'),origin='http://localhost:3000';let service;
 try{
 const queue=openDirectAvailabilityQueue(dbPath);queue.enqueue({anidbId:42,episodeId:1001,observedMs:100});queue.close();
 const db=new DatabaseSync(dbPath);db.exec("UPDATE direct_availability_targets SET state='available',verified_ms=100,proof_file_id=51,proof_library_id=102,proof_rating_key=500,proof_part_id=900");db.close();
 const accounts=openAccountLedger(dbPath);await accounts.bootstrapAdmin({username:'Owner',password:'long-owner-passphrase'});accounts.close();
 service=await createUserService({dbPath,shokoBaseUrl:'http://shoko:8111/',shokoApiKey:'synthetic',sessionKey:randomBytes(32),publicOrigin:origin,secureCookies:false,now:()=>1000,fetchImpl:async url=>{
 if(url.pathname==='/api/v3/Series/AniDB/Search')return Response.json({Total:1,List:[{ID:42,Title:'Example'}]});
 if(url.pathname==='/api/v3/Series/AniDB/42')return Response.json({ID:42,Title:'Example',Type:'TV',AirDate:'2020-01-01',EndDate:'2020-02-01',EpisodeCount:total,Restricted:false});
 if(url.pathname==='/api/v3/Series/AniDB/42/Episode')return Response.json({Total:total,List:Array.from({length:total},(_,i)=>({ID:1001+i,AnimeID:42,EpisodeNumber:1+i,Type:'Episode',Title:'Episode '+i,AirDate:'2020-01-01'}))});
 return new Response(null,{status:503});}});
 const login=await service.app.inject({method:'POST',url:'/api/login',headers:{origin},payload:{username:'Owner',password:'long-owner-passphrase'}}),cookie=login.headers['set-cookie'].split(';')[0];
 await service.app.inject({method:'GET',url:'/api/catalogue/search?q=Example',headers:{cookie}});
 const detail=await service.app.inject({method:'GET',url:'/api/catalogue/42',headers:{cookie}});assert.notEqual(detail.json().episodes[0].availability,'available');
 assert.equal(service.getDirectAvailabilityStatus({anidbId:42,episodeId:1001}).state,'unknown');
 const session=(await service.app.inject({method:'GET',url:'/api/session',headers:{cookie}})).json();
 const created=await service.app.inject({method:'POST',url:'/api/requests',headers:{cookie,origin,'x-negev-csrf':session.csrfToken},payload:{anidbId:42,scope:'installment',requestKey:'observer-off'}});assert.equal(created.statusCode,202,created.body);
 const requests=openRequestLedger(dbPath);try{assert.deepEqual(requests.getRequest(created.json().requestId).episodeIds,Array.from({length:total},(_,i)=>1001+i));}finally{requests.close();}
 }finally{await service?.close();await rm(root,{recursive:true,force:true});}
});

