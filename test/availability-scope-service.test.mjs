import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openFileProofLedger} from '../src/availability/file-proof-ledger.mjs';
import {createPlexAvailabilityService} from '../src/availability/plex-availability-service.mjs';
const target={anidbId:42,episodeId:1001};const proof={fileId:7,libraryId:102,ratingKey:500,partId:600};
test('authenticated stable machine identity gates saved evidence, restart preserves, changed same-endpoint server retires',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'scope-service-'));const dbPath=path.join(dir,'state.sqlite');let machine='machine-a',clock=100,reads=0,fail=false;
 const create=()=>createPlexAvailabilityService({dbPath,shokoBaseUrl:'http://shoko:8111',shokoApiKey:'synthetic',plexBaseUrl:'http://plex:32400',plexToken:'synthetic-plex',publicSections:{episode:[102],movie:[]},shokoMount:{appRoot:'/pure',localRoot:dir},plexMount:{appRoot:'/plex',localRoot:dir},enforceScope:true,now:()=>clock,fetchImpl:async(u,init)=>{assert.equal(u.pathname,'/identity');assert.equal(init.redirect,'manual');assert.equal(init.headers['X-Plex-Token'],'synthetic-plex');reads++;return Response.json({MediaContainer:{machineIdentifier:machine}},{status:fail?503:200});}});
 let service=create();const files=openFileProofLedger(dbPath,{positiveLifetimeMs:1000000,now:()=>clock,evidenceTrusted:()=>service.isScopeCurrent()});
 try {
 assert.equal(service.isScopeCurrent(),false);await Promise.all([service.ensureScope(),service.ensureScope()]);assert.equal(reads,1);
 files.observe({...target,proof,checkedMs:clock});assert.equal(files.getCurrent(target).state,'available');
 service.close();service=create();assert.equal(files.getCurrent(target).state,'unknown');await service.ensureScope();assert.equal(files.getCurrent(target).state,'available');
 clock+=300001;fail=true;await service.ensureScope();assert.equal(files.getCurrent(target).state,'unknown');
 const failedReads=reads;await service.ensureScope();await service.ensureScope();assert.equal(reads,failedReads);
 clock+=30001;fail=false;await service.ensureScope();assert.equal(files.getCurrent(target).state,'available');
 assert.equal(service.getScopeGeneration(),1);
 clock+=300001;machine='machine-b';await service.ensureScope();assert.equal(service.isScopeCurrent(),true);assert.equal(files.getCurrent(target).state,'unknown');
 assert.equal(service.getScopeGeneration(),2);
 }finally{service.close();files.close();rmSync(dir,{recursive:true,force:true});}
});
test('closing while identity is pending aborts and prevents a late scope reconciliation',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'scope-close-'));let abort=false;
 const service=createPlexAvailabilityService({dbPath:path.join(dir,'state.sqlite'),shokoBaseUrl:'http://shoko:8111',shokoApiKey:'synthetic',plexBaseUrl:'http://plex:32400',plexToken:'synthetic',publicSections:{episode:[102],movie:[]},shokoMount:{appRoot:'/pure',localRoot:dir},plexMount:{appRoot:'/plex',localRoot:dir},enforceScope:true,fetchImpl:async(u,init)=>new Promise((resolve,reject)=>init.signal.addEventListener('abort',()=>{abort=true;reject(new Error('aborted'));},{once:true}))});
 try{const pending=service.ensureScope();service.close();assert.equal((await pending).state,'held');assert.equal(abort,true);assert.equal(service.isScopeCurrent(),false);}
 finally{rmSync(dir,{recursive:true,force:true});}
});
test('an old server page cannot repopulate the index after scope generation changes',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'scope-race-'));const dbPath=path.join(dir,'state.sqlite');let clock=100,machine='a',release,entered;
 const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
 const service=createPlexAvailabilityService({dbPath,shokoBaseUrl:'http://shoko:8111',shokoApiKey:'synthetic',plexBaseUrl:'http://plex:32400',plexToken:'synthetic',publicSections:{episode:[102],movie:[]},shokoMount:{appRoot:'/pure',localRoot:dir},plexMount:{appRoot:'/plex',localRoot:dir},enforceScope:true,now:()=>clock,fetchImpl:async u=>{if(u.pathname==='/identity')return Response.json({MediaContainer:{machineIdentifier:machine}});if(u.pathname==='/library/sections/102')return Response.json({MediaContainer:{librarySectionID:102,Directory:[{type:'4',key:'/library/sections/102/all?type=4'}]}});if(u.pathname==='/library/sections/102/all'){entered();await gate;return Response.json({MediaContainer:{size:1,totalSize:1,offset:0,Metadata:[{ratingKey:'500',type:'episode',librarySectionID:102,Media:[{id:700,Part:[{id:900,size:5,file:'/plex/old.mkv'}]}]}]}});}throw new Error('unexpected '+u);}});
 try{await service.ensureScope();const old=service.tick({libraryId:102,kind:'episode'});await started;clock+=300001;machine='b';await service.ensureScope();release();await old;const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(dbPath);try{assert.equal(db.prepare('SELECT COUNT(*) AS n FROM plex_card_observations').get().n,0);}finally{db.close();}}
 finally{service.close();rmSync(dir,{recursive:true,force:true});}
});
