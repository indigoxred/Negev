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

import {openShokoInventoryLedger} from '../src/availability/shoko-inventory-worker.mjs';

test('feed reconnect during a known-file missing read cannot retire that file',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'negev-known-recent-race-')),dbPath=path.join(root,'state.sqlite');let service,reads=0;
 const inventory=openShokoInventoryLedger(dbPath);inventory.recordFileObservation({item:{fileId:10,updated:'2026-11-28T00:00:00Z',state:'provisional',pairs:[]},observedMs:100});
 try{
  service=await createUserService({dbPath,shokoBaseUrl:'http://shoko.invalid:8111',shokoApiKey:'synthetic',sessionKey:randomBytes(32),publicOrigin:'http://localhost:3000',secureCookies:false,shokoRecent:true,now:()=>1000,
   fetchImpl:async()=>{if(++reads===1)queueMicrotask(()=>service.flagShokoReconciliation('feed_reconnected'));return new Response('',{status:404});}});
  const recent=openShokoRecentLedger(dbPath);try{recent.bootstrap({fileId:10,importedNs:'1800000000000000000'},[10]);}finally{recent.close();}
  assert.equal((await service.tickShokoRecentDrain()).state,'retry_scheduled');assert.equal(service.getRecentScannerStatus().pending,1);
 }finally{await service?.close();inventory.close();await rm(root,{recursive:true,force:true});}
});

test('an invalidation after a provisional write cannot become unsupported-link retirement proof',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'negev-recent-write-race-')),dbPath=path.join(root,'state.sqlite');let service,armed=false;
 const inventory=openShokoInventoryLedger(dbPath),originalPrepare=DatabaseSync.prototype.prepare;
 try{
  DatabaseSync.prototype.prepare=function(sql,...args){
   const statement=originalPrepare.call(this,sql,...args);
   if(sql.includes('INSERT INTO shoko_inventory_files')){
    const run=statement.run;
    statement.run=function(...values){const result=run.apply(this,values);if(armed){armed=false;queueMicrotask(()=>inventory.invalidateFileEvent({fileId:10,observedMs:2000}));}return result;};
   }
   return statement;
  };
  service=await createUserService({dbPath,shokoBaseUrl:'http://shoko.invalid:8111',shokoApiKey:'synthetic',sessionKey:randomBytes(32),publicOrigin:'http://localhost:3000',secureCookies:false,shokoRecent:true,now:()=>1000,
   fetchImpl:async()=>Response.json({ID:10,Updated:'2026-11-28T00:00:00Z',SeriesIDs:[]})});
  DatabaseSync.prototype.prepare=originalPrepare;
  const recent=openShokoRecentLedger(dbPath);try{recent.bootstrap({fileId:10,importedNs:'1800000000000000000'},[10]);}finally{recent.close();}
  armed=true;assert.equal((await service.tickShokoRecentDrain()).state,'retry_scheduled');
  assert.equal(service.getRecentScannerStatus().pending,1);assert.equal(inventory.getFile(10).state,'unverified');
 }finally{DatabaseSync.prototype.prepare=originalPrepare;await service?.close();inventory.close();await rm(root,{recursive:true,force:true});}
});
