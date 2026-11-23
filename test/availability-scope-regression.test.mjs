import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openAvailabilityScope} from '../src/availability/availability-scope.mjs';
import {openDirectAvailabilityQueue} from '../src/availability/direct-availability-queue.mjs';
import {openFileProofLedger} from '../src/availability/file-proof-ledger.mjs';
import {openPlexCardIndex} from '../src/availability/plex-card-index.mjs';
const target={anidbId:42,episodeId:1001};
const proof={fileId:7,libraryId:102,ratingKey:500,partId:600};
const config={serverIdentity:'synthetic-server',episodeLibraryIds:[102],movieLibraryIds:[],shokoMount:{appRoot:'/pure',localRoot:'C:\\media'},plexMounts:[{appRoot:'/anime',localRoot:'C:\\media'}]};
for (const [name,change] of [['server',{serverIdentity:'different-server'}],['section',{episodeLibraryIds:[103]}],['mount',{plexMounts:[{appRoot:'/anime',localRoot:'C:\\new-media'}]}]]) test(`changed ${name} retires proofs and fences claims; unchanged restart preserves`,()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'scope-evidence-'));const dbPath=path.join(dir,'state.sqlite');
 const queue=openDirectAvailabilityQueue(dbPath);const files=openFileProofLedger(dbPath,{positiveLifetimeMs:1000,now:()=>100});
 let scope=openAvailabilityScope(dbPath);
 const index=openPlexCardIndex(dbPath);
 try {
 scope.reconcile({...config,observedMs:1});
 index.advanceCursor({libraryId:102,kind:'episode',expectedOffset:0,nextOffset:5,pageKeys:[1,2,3,4,5],totalSize:10,observedMs:1});
 assert.equal(index.getCursor({libraryId:102,kind:'episode'}),5);
 queue.enqueue({...target,observedMs:2});const receipt=queue.claimNext({nowMs:3});
 queue.recordResult({claim:receipt,state:'available',checkedMs:4,proof});files.observe({...target,proof,checkedMs:4});
 scope.close();scope=openAvailabilityScope(dbPath);
 assert.equal(scope.reconcile({...config,observedMs:5}).state,'unchanged');
 assert.equal(index.getCursor({libraryId:102,kind:'episode'}),5);
 assert.equal(files.getCurrent(target).state,'available');assert.equal(queue.getStatus({...target,nowMs:6}).state,'available');
 queue.enqueue({...target,observedMs:7});const stale=queue.claimNext({nowMs:8});
 assert.equal(scope.reconcile({...config,...change,observedMs:9}).state,'changed');
 assert.equal(index.getCursor({libraryId:102,kind:'episode'}),0);
 assert.equal(files.getCurrent(target).state,'unknown');assert.equal(queue.getStatus({...target,nowMs:10}).state,'unknown');
 assert.equal(queue.recordResult({claim:stale,state:'available',checkedMs:11,proof}).state,'held');
 }finally {scope.close();index.close();queue.close();files.close();rmSync(dir,{recursive:true,force:true});}
});
