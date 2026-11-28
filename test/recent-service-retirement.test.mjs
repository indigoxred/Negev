import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createUserService} from '../src/web/user-service.mjs';
import {openShokoRecentLedger} from '../src/availability/shoko-recent-ledger.mjs';

for(const outcome of ['removed','unsupported','provisional','outage','event_race'])test(`real recent service queue handles ${outcome} without manufacturing public proof`,async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'negev-recent-service-')),dbPath=path.join(root,'state.sqlite');let service,reads=0;
 try{
  service=await createUserService({dbPath,shokoBaseUrl:'http://shoko.invalid:8111',shokoApiKey:'synthetic',sessionKey:randomBytes(32),publicOrigin:'http://localhost:3000',secureCookies:false,shokoRecent:true,now:()=>1000,
   fetchImpl:async url=>{
    assert.equal(new URL(url).pathname,'/api/v3/File/10');reads++;
    if(outcome==='event_race'&&reads===2)service.flagShokoReconciliation('feed_reconnected');
    if(outcome==='removed'||outcome==='outage'||outcome==='event_race')return new Response('',{status:outcome==='outage'?503:404});
    return Response.json({ID:10,Updated:'2026-11-28T00:00:00Z',SeriesIDs:outcome==='unsupported'?Array.from({length:101},()=>({})):[]});
   }});
  assert.equal(service.getRecentScannerStatus().state,'required');
  const recent=openShokoRecentLedger(dbPath);try{recent.bootstrap({fileId:10,importedNs:'1800000000000000000'},[10]);}finally{recent.close();}
  assert.equal(service.getRecentScannerStatus().state,'ready');
  const result=await service.tickShokoRecentDrain();
  assert.equal(result.state,['removed','unsupported'].includes(outcome)?'retired':'retry_scheduled',JSON.stringify(result));
  assert.equal(service.getRecentScannerStatus().pending,['removed','unsupported'].includes(outcome)?0:1);
  if(outcome==='removed')assert.equal(reads,2);
  assert.deepEqual(service.getObservedShokoFileIds({anidbId:42,episodeId:1001}),[]);
  const db=new DatabaseSync(dbPath);try{assert.equal(db.prepare('SELECT COUNT(*) n FROM shoko_recent_retirements').get().n,['removed','unsupported'].includes(outcome)?1:0);}finally{db.close();}
 }finally{await service?.close();await rm(root,{recursive:true,force:true});}
});
