import{openShokoInventoryLedger}from'../src/availability/shoko-inventory-worker.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import{randomBytes}from'node:crypto';import{createUserService}from'../src/web/user-service.mjs';import{openShokoRecentLedger}from'../src/availability/shoko-recent-ledger.mjs';
for(const mode of ['removed','moved','newer','unknown'])test(`missed hash ${mode} path reconciles only exact settled observations`,async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'missed-path-')),dbPath=path.join(root,'state.sqlite'),importRoot=path.join(root,'Import');await mkdir(importRoot);let service,newDetection=false;
 const baseline=openShokoRecentLedger(dbPath);baseline.bootstrap({fileId:10,importedNs:String(BigInt(Date.parse('2026-10-31T00:00:10Z'))*1000000n)});baseline.close();const inventory=openShokoInventoryLedger(dbPath);inventory.recordFileObservation({item:{fileId:10,state:'linked',updated:'2026-10-31T00:00:10Z',pairs:[{anidbId:42,episodeId:1000}]},observedMs:100});inventory.close();
 try{if(mode==='unknown')await writeFile(path.join(importRoot,'old.mkv'),'unknown');if(mode==='moved')await writeFile(path.join(importRoot,'renamed.mkv'),'linked');
 service=await createUserService({dbPath,shokoBaseUrl:'http://shoko:8111/',shokoApiKey:'synthetic',sessionKey:randomBytes(32),publicOrigin:'http://localhost:3000',secureCookies:false,shokoRecent:true,shokoImportRoot:importRoot,shokoImportFolderId:1,readShokoConnectionState:()=>({state:'connected'}),fetchImpl:async url=>{
 if(url.pathname==='/api/v3/Queue'){if(mode==='newer'&&!newDetection){newDetection=true;service.acceptShokoEvent('file:detected',[{ManagedFolderID:1,RelativePath:'old.mkv'}]);}return Response.json({WaitingCount:0,BlockedCount:0,ScheduledCount:0,TotalCount:0,CurrentlyExecuting:[],Pools:[]});}
 if(url.pathname==='/api/v3/ManagedFolder/1/File')return Response.json({Total:1,List:[{ID:11,Size:6,SeriesIDs:[{ID:42}],Locations:[{ManagedFolderID:1,RelativePath:'renamed.mkv',IsAccessible:true}]}]});
 if(url.pathname==='/api/v3/File')return Response.json({Total:1,List:[{ID:10,Imported:'2026-10-31T00:00:10Z'}]});return new Response(null,{status:404});}});
 service.acceptShokoEvent('file:detected',[{ManagedFolderID:1,RelativePath:'old.mkv'}]);const scanned=await service.tickShokoRecentScan();
 const held=mode==='unknown'||mode==='newer';assert.equal(service.getShokoArrivalState().pendingPaths,held?1:0);assert.equal(service.getShokoEventState().reconciliationNeeded,held,JSON.stringify(scanned));
 }finally{await service?.close();await rm(root,{recursive:true,force:true});}
});

