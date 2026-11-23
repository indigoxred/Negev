import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';import path from 'node:path';
import {openDirectAvailabilityQueue} from '../src/availability/direct-availability-queue.mjs';
import {openShokoInventoryLedger} from '../src/availability/shoko-inventory-worker.mjs';
test('completed multipart direct positive is withdrawn when second component changes',()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'direct-components-')),dbPath=path.join(dir,'state.sqlite');const queue=openDirectAvailabilityQueue(dbPath),inventory=openShokoInventoryLedger(dbPath);const target={anidbId:42,episodeId:1001};
 try{
 for(const fileId of [7,8])inventory.recordFileObservation({item:{fileId,updated:'2026-11-01T00:00:00Z',state:'linked',pairs:[target]},observedMs:1});
 queue.enqueue({...target,observedMs:2});const receipt=queue.claimNext({nowMs:3});
 const parts=[7,8].map((fileId,i)=>({fileId,libraryId:102,ratingKey:500,partId:600+i,mediaId:900,partIndex:i,partCount:2}));
 queue.recordResult({claim:receipt,state:'available',checkedMs:4,proof:{...parts[0],parts}});
 assert.equal(queue.getStatus({...target,nowMs:5}).state,'available');
 inventory.invalidateFileEvent({fileId:8,observedMs:6});
 assert.equal(queue.getStatus({...target,nowMs:7}).state,'unknown');
 assert.deepEqual(queue.getRecentAvailableIds({anidbId:42,nowMs:7}),[]);
 const inFlight=queue.claimNext({nowMs:8});
 inventory.invalidateFileEvent({fileId:8,observedMs:9});
 assert.equal(queue.recordResult({claim:inFlight,state:'available',checkedMs:10,proof:{...parts[0],parts}}).reason,'source_generation_changed');
 assert.equal(queue.getStatus({...target,nowMs:11}).state,'unknown');
 }finally{inventory.close();queue.close();rmSync(dir,{recursive:true,force:true});}
});
