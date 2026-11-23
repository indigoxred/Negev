import {openAcquisitionLedger} from '../src/acquisition/acquisition-ledger.mjs';
import {openAcquisitionRequestQueue} from '../src/acquisition/acquisition-request-queue.mjs';
import {requestPresentation} from '../src/web/public/request-progress-text.mjs';
const NOW=Date.UTC(2026,10,23,6);
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openAccountLedger } from '../src/auth/account-ledger.mjs';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { createUserService } from '../src/web/user-service.mjs';

test('authenticated Watching response carries bounded pending-today evidence into request presentation',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'negev-watch-schedule-')),dbPath=path.join(dir,'negev.sqlite');
 const accounts=openAccountLedger(dbPath,{now:()=>NOW});const owner=await accounts.bootstrapAdmin({username:'Owner',password:'long-owner-passphrase'});accounts.close();
 const ledger=openRequestLedger(dbPath);ledger.submit({requesterId:owner.id,requestKey:'watch',nowMs:1000,intent:{state:'ready',anidbId:42,title:'Airing title',kind:'series',episodeIds:[1],monitorFuture:true}});ledger.close();
 const acquisitions=openAcquisitionLedger(dbPath),queue=openAcquisitionRequestQueue(dbPath);const claim=queue.claimNext({nowMs:NOW});queue.recordResult({requestId:claim.requestId,pass:claim.pass,state:'held',reason:'no_release_candidates',checkedMs:NOW});queue.close();acquisitions.close();
 let finish,reads=0;const wait=new Promise(r=>finish=r);const service=await createUserService({dbPath,shokoBaseUrl:'http://shoko.internal:8111',shokoApiKey:'synthetic',sessionKey:randomBytes(32),publicOrigin:'http://localhost:3000',secureCookies:false,now:()=>NOW,today:()=> '2026-11-23',fetchImpl:async(url)=>{
  if(String(url)==='https://animap.id/api/anidb/42/raw'){reads++;await wait;return Response.json({anime:{'@id':'42','@restricted':'false',type:'TV Series',startdate:'2026-11-15',episodecount:'2',titles:{title:{'@type':'main','#text':'Airing title'}},episodes:{episode:[{'@id':'1',epno:{'@type':'1','#text':'1'},title:{'#text':'First'},airdate:'2026-11-23'},{'@id':'2',epno:{'@type':'1','#text':'2'},title:{'#text':'Second'},airdate:'2026-11-29'}]}}});}
  return new Response(null,{status:404});
 }});
 try{
  const login=await service.app.inject({method:'POST',url:'/api/login',headers:{origin:'http://localhost:3000'},payload:{username:'Owner',password:'long-owner-passphrase'}});const cookie=login.headers['set-cookie'].split(';')[0];
  const cold=await service.app.inject({method:'GET',url:'/api/requests?view=watching',headers:{cookie}});assert.equal(cold.statusCode,200,cold.body);assert.equal(cold.json().items.length,1);assert.equal(cold.json().items[0].nextAir,null);assert.equal(reads,1);
  finish();let item;for(let i=0;i<20;i++){await new Promise(r=>setImmediate(r));const r=await service.app.inject({method:'GET',url:'/api/requests?view=watching',headers:{cookie}});item=r.json().items[0];if(item.nextAir)break;}
  assert.deepEqual(item.nextAir,{nextAirDate:'2026-11-23',nextEpisodeNumber:1});assert.equal(reads,1);assert.equal(item.monitorFuture,true);
  assert.deepEqual(item.progress.scheduledToday,{asOf:'2026-11-23',targetCount:1,verifiedTargets:0,pendingEpisodeNumbers:[1]});
  assert.equal(item.progress.waitingForRelease,true);assert.equal(requestPresentation(item.progress,item.kind,{monitorFuture:item.monitorFuture,nowMs:NOW}).stage,"Waiting for today's episode");
 }finally{finish();await service.close();await rm(dir,{recursive:true,force:true});}
});
