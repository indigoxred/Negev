import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,stat,rename} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';
import {openShokoInventoryLedger} from '../src/availability/shoko-inventory-worker.mjs';
import {openPlexCardIndex} from '../src/availability/plex-card-index.mjs';
import {openFileProofLedger} from '../src/availability/file-proof-ledger.mjs';
import {availabilityScopeSignature} from '../src/availability/availability-scope.mjs';
import {importQualifiedAvailability} from '../src/availability/import-qualified-cache.mjs';
async function fixture(run){
 const root=await mkdtemp(path.join(os.tmpdir(),'negev-qualified-')),dbPath=path.join(root,'state.sqlite'),file=path.join(root,'episode.mkv');await writeFile(file,'video');const info=await stat(file,{bigint:true}),storageKey=`${info.dev}:${info.ino}:${info.size}`;
 const scope={serverIdentity:'test-server',episodeLibraryIds:[102],movieLibraryIds:[],shokoMount:{appRoot:'/pure',localRoot:root},plexMounts:[{appRoot:'/plex',localRoot:root}],observedMs:2000};
 const inventory=openShokoInventoryLedger(dbPath),index=openPlexCardIndex(dbPath),proofs=openFileProofLedger(dbPath,{positiveLifetimeMs:10000,now:()=>2000});
 const item={fileId:7,state:'linked',updated:'2026-11-20T00:00:00Z',pairs:[{anidbId:42,episodeId:1001}]};inventory.recordFileObservation({item,observedMs:100});
 const card={libraryId:102,ratingKey:500,kind:'episode',observedMs:200,parts:[{libraryId:102,partId:600,size:5,plexPath:'/plex/episode.mkv',candidateKey:storageKey}]};index.recordCard(card);
 const db=new DatabaseSync(dbPath);db.exec("CREATE TABLE retained_ownership (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO retained_ownership VALUES(1,'keep');");
 const signature=db.prepare('SELECT identity_signature FROM plex_card_observations').get().identity_signature;
 const receipt={anidbId:42,episodeId:1001,checkedMs:300,proof:{fileId:7,libraryId:102,ratingKey:500,partId:600,storageKey},revision:{source:{updated:item.updated,observedMs:100},card:{observedMs:200,identitySignature:signature}}};
 const manifest={formatVersion:1,migrationId:'test-qualification',scopeSignature:availabilityScopeSignature(scope),qualifiedAtMs:400,cards:[card],receipts:[receipt]};
 try{await run({root,dbPath,file,scope,manifest,db,inventory,proofs,index})}finally{db.close();inventory.close();index.close();proofs.close();await rm(root,{recursive:true,force:true})}
}
test('qualified cache survives first scope initialization and restart without rebasing evidence',async()=>fixture(async f=>{
 const result=await importQualifiedAvailability({...f,positiveLifetimeMs:10000,now:()=>2000});assert.equal(result.recorded,1);assert.equal(f.proofs.getCurrent({anidbId:42,episodeId:1001}).verifiedAtMs,300);assert.equal(f.db.prepare('SELECT value FROM retained_ownership').get().value,'keep');
 assert.equal((await importQualifiedAvailability({...f,positiveLifetimeMs:10000,now:()=>2100})).recorded,1);assert.equal(f.proofs.getCurrent({anidbId:42,episodeId:1001}).verifiedAtMs,300);
}));
test('changed source generations do not become available',async()=>fixture(async f=>{
 f.inventory.recordFileObservation({item:{fileId:7,state:'linked',updated:'2026-11-21T00:00:00Z',pairs:[{anidbId:42,episodeId:1001}]},observedMs:500});
 const result=await importQualifiedAvailability({...f,positiveLifetimeMs:10000,now:()=>2000});assert.equal(result.recorded,0);assert.notEqual(f.proofs.getCurrent({anidbId:42,episodeId:1001}).state,'available');
}));
test('a different same-size physical file cannot reuse qualified evidence',async()=>fixture(async f=>{
 await rename(f.file,f.file+'.original');await writeFile(f.file,'other');const result=await importQualifiedAvailability({...f,positiveLifetimeMs:10000,now:()=>2000});assert.equal(result.recorded,0);
}));
for(const mode of ['scope','future','card'])test(`invalid ${mode} input leaves live cache unchanged`,async()=>fixture(async f=>{
 if(mode==='scope')f.manifest.scopeSignature='0'.repeat(64);if(mode==='future')f.manifest.qualifiedAtMs=9000;if(mode==='card')f.manifest.cards[0].parts[0].plexPath='../escape';
 await assert.rejects(importQualifiedAvailability({...f,positiveLifetimeMs:10000,now:()=>2000}));assert.equal(f.db.prepare('SELECT COUNT(*) n FROM plex_card_observations').get().n,1);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='availability_scope'").get().n,0);
}));
test('source changes while preparing cache abort the atomic publication',async()=>fixture(async f=>{
 let called=false;await assert.rejects(importQualifiedAvailability({...f,positiveLifetimeMs:10000,now:()=>2000,probeImpl:async()=>{if(!called){called=true;f.inventory.recordFileObservation({item:{fileId:7,state:'unverified',updated:'2026-11-21T00:00:00Z',pairs:[]},observedMs:500})}return{state:'candidate',candidateKey:f.manifest.receipts[0].proof.storageKey}}}),/changed/);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM plex_card_observations').get().n,1);
}));
test('expired evidence stays expired instead of acquiring a fresh migration timestamp',async()=>fixture(async f=>{
 const result=await importQualifiedAvailability({...f,positiveLifetimeMs:1000,now:()=>2000});assert.equal(result.recorded,0);
}));

for(const mode of ['scalar','incomplete','duplicate','complete'])test(`qualified multipart ${mode} receipt requires every ordered physical witness`,async()=>fixture(async f=>{
 const secondFile=path.join(f.root,'episode-part2.mkv');await writeFile(secondFile,'part2');const info=await stat(secondFile,{bigint:true}),secondKey=`${info.dev}:${info.ino}:${info.size}`;
 const updated='2026-11-20T00:00:00Z';f.inventory.recordFileObservation({item:{fileId:8,state:'linked',updated,pairs:[{anidbId:42,episodeId:1001}]},observedMs:100});
 const card=f.manifest.cards[0];Object.assign(card.parts[0],{mediaId:700,partIndex:0,partCount:2});card.parts.push({libraryId:102,partId:601,size:5,plexPath:'/plex/episode-part2.mkv',candidateKey:secondKey,mediaId:700,partIndex:1,partCount:2});card.observedMs=201;f.index.recordCard(card);
 const receipt=f.manifest.receipts[0];receipt.revision.card=f.index.getCardRevision({libraryId:102,ratingKey:500});
 if(mode!=='scalar'){
  const first={...receipt.proof,mediaId:700,partIndex:0,partCount:2};
  const second={fileId:8,libraryId:102,ratingKey:500,partId:601,storageKey:secondKey,mediaId:700,partIndex:1,partCount:2};
  receipt.proof.parts=mode==='incomplete'?[first]:mode==='duplicate'?[first,first]:[first,second];
  receipt.revision.sources=[{fileId:7,updated,observedMs:100},{fileId:8,updated,observedMs:100}];
 }
 const result=await importQualifiedAvailability({...f,positiveLifetimeMs:10000,now:()=>2000});
 assert.equal(result.recorded,mode==='complete'?1:0);const current=f.proofs.getCurrent({anidbId:42,episodeId:1001});
 if(mode==='complete'){assert.equal(current.state,'available');assert.equal(current.verifiedAtMs,300);assert.equal(result.physicalFilesChecked,2);}else assert.notEqual(current.state,'available');
}));

for(const mode of ['changed','removed'])test(`first scope initialization does not resurrect a newer ${mode} card generation`,async()=>fixture(async f=>{
 if(mode==='changed')f.index.recordCard({...f.manifest.cards[0],observedMs:500,parts:f.manifest.cards[0].parts.map(part=>({...part,itemGuid:'newer-card-identity'}))});
 else f.index.forgetCard({libraryId:102,ratingKey:500,observedMs:500});
 const result=await importQualifiedAvailability({...f,positiveLifetimeMs:10000,now:()=>2000});assert.equal(result.recorded,0);assert.notEqual(f.proofs.getCurrent({anidbId:42,episodeId:1001}).state,'available');
}));


test('later unchanged card observation preserves the original verified time and latest card generation',async()=>fixture(async f=>{
 f.index.recordCard({...f.manifest.cards[0],observedMs:500});
 const result=await importQualifiedAvailability({...f,positiveLifetimeMs:10000,now:()=>2000});
 assert.equal(result.recorded,1);assert.equal(f.proofs.getCurrent({anidbId:42,episodeId:1001}).verifiedAtMs,300);
 assert.equal(f.db.prepare('SELECT observed_ms FROM plex_card_observations WHERE rating_key=500').get().observed_ms,500);
}));

test('equal-time conflicting card snapshots abort instead of choosing one identity',async()=>fixture(async f=>{
 const row=f.db.prepare('SELECT identity_signature FROM plex_card_observations').get();const signature=JSON.parse(row.identity_signature);signature[1][0][3]='different-guid';f.db.prepare('UPDATE plex_card_observations SET identity_signature=?').run(JSON.stringify(signature));
 await assert.rejects(importQualifiedAvailability({...f,positiveLifetimeMs:10000,now:()=>2000}),/Conflicting/);
 assert.equal(f.db.prepare('SELECT identity_signature FROM plex_card_observations').get().identity_signature,JSON.stringify(signature));
}));

test('migration scratch files stay in the writable private database directory',async()=>fixture(async f=>{
 const {readdir}=await import('node:fs/promises');let privateScratch=false;
 await importQualifiedAvailability({...f,positiveLifetimeMs:10000,now:()=>2000,probeImpl:async()=>{privateScratch=(await readdir(f.root)).some(name=>name.startsWith('.cache-upgrade-'));return{state:'candidate',candidateKey:f.manifest.receipts[0].proof.storageKey}}});
 assert.equal(privateScratch,true);assert.equal((await readdir(f.root)).some(name=>name.startsWith('.cache-upgrade-')),false);
}));

test('explicit scratch directory cannot escape the private database root',async()=>fixture(async f=>{
 await assert.rejects(importQualifiedAvailability({...f,positiveLifetimeMs:10000,now:()=>2000,scratchDir:path.dirname(f.root)}),/Private migration scratch/);
}));

test('cache publication preserves populated title jobs with foreign keys enabled',async()=>fixture(async f=>{
 const {openTitleCheckLedger}=await import('../src/availability/title-check-ledger.mjs');const jobs=openTitleCheckLedger(f.dbPath);
 try{jobs.start({anidbId:42,nowMs:10});const claim=jobs.claimNext({nowMs:11});jobs.recordPage({claim,detail:{state:'details',anidbId:42,kind:'series',page:1,total:1,nextPage:null,episodes:[{id:1001}]},checkedMs:12});
  assert.equal((await importQualifiedAvailability({...f,positiveLifetimeMs:10000,now:()=>2000})).recorded,1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM title_check_jobs').get().n,1);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM title_check_targets').get().n,1);assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{jobs.close();}
}));
test('frozen v300 availability schema imports atomically with original times and rollback on conflict',async()=>fixture(async f=>{
 const {readFile}=await import('node:fs/promises'),dbPath=path.join(f.root,'v300.sqlite'),old=new DatabaseSync(dbPath);old.exec(await readFile(new URL('./fixtures/availability-schema-v300.sql',import.meta.url),'utf8'));old.exec("CREATE TABLE retained_ownership(id INTEGER PRIMARY KEY,value TEXT);INSERT INTO retained_ownership VALUES(1,'keep')");
 for(const name of ['shoko_inventory_files','shoko_inventory_pairs','shoko_inventory_file_hints','plex_card_observations','plex_part_candidates'])for(const row of f.db.prepare(`SELECT * FROM ${name}`).all()){const columns=Object.keys(row);old.prepare(`INSERT INTO ${name}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).run(...Object.values(row));}
 const before=old.prepare("SELECT sql FROM sqlite_master WHERE name='file_availability_proofs'").get().sql;old.close();
 await assert.rejects(importQualifiedAvailability({...f,dbPath,positiveLifetimeMs:10000,now:()=>2000,probeImpl:async()=>{const concurrent=new DatabaseSync(dbPath);concurrent.prepare('UPDATE shoko_inventory_files SET observed_ms=101').run();concurrent.close();return{state:'candidate',candidateKey:f.manifest.receipts[0].proof.storageKey};}}),/changed/);
 let check=new DatabaseSync(dbPath);assert.equal(check.prepare("SELECT sql FROM sqlite_master WHERE name='file_availability_proofs'").get().sql,before);check.prepare('UPDATE shoko_inventory_files SET observed_ms=100').run();check.close();
 const result=await importQualifiedAvailability({...f,dbPath,positiveLifetimeMs:10000,now:()=>2000});assert.equal(result.recorded,1);const proofs=openFileProofLedger(dbPath,{positiveLifetimeMs:10000,now:()=>2000});try{assert.equal(proofs.getCurrent({anidbId:42,episodeId:1001}).verifiedAtMs,300);}finally{proofs.close();}check=new DatabaseSync(dbPath);assert.equal(check.prepare('SELECT value FROM retained_ownership').get().value,'keep');check.close();
}));
