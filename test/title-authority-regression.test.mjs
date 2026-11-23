import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTitleCheckLedger } from '../src/availability/title-check-ledger.mjs';
import { openPlexCardIndex } from '../src/availability/plex-card-index.mjs';
import { openShokoInventoryLedger } from '../src/availability/shoko-inventory-worker.mjs';
const proof = { fileId:7, libraryId:102, ratingKey:500, partId:600 };
const target = { anidbId:42, episodeId:1001 };
function fixture(run) {
 const dir=mkdtempSync(path.join(os.tmpdir(),'title-authority-'));
 const dbPath=path.join(dir,'state.sqlite');
 const titles=openTitleCheckLedger(dbPath,{requireProof:true});
 const plex=openPlexCardIndex(dbPath);
 try { run({titles,plex,dbPath}); } finally { titles.close(); plex.close(); rmSync(dir,{recursive:true,force:true}); }
}
function claim(titles) {
 titles.start({anidbId:42,nowMs:1});
 titles.recordPage({claim:titles.claimNext({nowMs:2}),detail:{state:'details',anidbId:42,kind:'series',page:1,total:1,nextPage:null,episodes:[{id:1001}]},checkedMs:3});
 return titles.claimNext({nowMs:4});
}
test('removed Plex card retires witnessed title positive',()=>fixture(({titles,plex})=>{
 titles.recordTarget({claim:claim(titles),status:'available',checkedMs:5,proof});
 assert.equal(titles.getTargetStatus({...target,nowMs:6}).state,'available');
 plex.forgetCard({libraryId:102,ratingKey:500,observedMs:7});
 assert.deepEqual(titles.getTargetStatus({...target,nowMs:8}),{state:'unknown'});
 assert.deepEqual(titles.getRecentAvailableIds({anidbId:42,nowMs:8}),[]);
 assert.equal(titles.getProgress({anidbId:42,nowMs:8}).recentAvailableCount,0);
}));
test('card deletion during observation fences stale title result',()=>fixture(({titles,plex})=>{
 const receipt=claim(titles);
 plex.forgetCard({libraryId:102,ratingKey:500,observedMs:5});
 assert.equal(titles.recordTarget({claim:receipt,status:'available',checkedMs:6,proof}).state,'held');
 assert.deepEqual(titles.getTargetStatus({...target,nowMs:7}),{state:'unknown'});
}));
test('strict title ledger does not publish unwitnessed status',()=>fixture(({titles})=>{
 titles.recordTarget({claim:claim(titles),status:'available',checkedMs:5});
 assert.deepEqual(titles.getTargetStatus({...target,nowMs:6}),{state:'unknown'});
}));
test('the second multipart source invalidates title witness and its in-flight result',()=>fixture(({titles,dbPath})=>{
 const inventory=openShokoInventoryLedger(dbPath);
 try {
  for(const fileId of [7,8])inventory.recordFileObservation({item:{fileId,updated:'2026-11-01T00:00:00Z',state:'linked',pairs:[target]},observedMs:1});
  const parts=[7,8].map((fileId,i)=>({...proof,fileId,partId:600+i,mediaId:900,partIndex:i,partCount:2}));
  const composite={...parts[0],parts};
  titles.recordTarget({claim:claim(titles),status:'available',checkedMs:5,proof:composite});
  assert.equal(titles.getTargetStatus({...target,nowMs:6}).state,'available');
  inventory.invalidateFileEvent({fileId:8,observedMs:7});
  assert.equal(titles.getTargetStatus({...target,nowMs:8}).state,'unknown');
  const receipt=titles.claimNext({nowMs:9});
  inventory.invalidateFileEvent({fileId:8,observedMs:10});
  assert.equal(titles.recordTarget({claim:receipt,status:'available',checkedMs:11,proof:composite}).state,'held');
 }finally{inventory.close();}
}));
