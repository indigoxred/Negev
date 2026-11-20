import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { openAcquisitionRequestQueue } from '../src/acquisition/acquisition-request-queue.mjs';
const preference={group:'SubsPlease',audio:'japanese',knownEpisodeIds:[101],createdMs:100};
const candidate={guid:'alternative',indexerId:1,title:'[Other] Example - 02 1080p',size:1000,seeders:20,evidence:'unverified'};
const preview={torrentHash:'a'.repeat(40),episodeIds:[102],files:[{name:'Example - 02.mkv',size:1000,episodeIds:[102]}]};
async function fixture(run){
 const dir=await mkdtemp(path.join(tmpdir(),'negev-preferred-'));const dbPath=path.join(dir,'state.sqlite');let ledger=openRequestLedger(dbPath);
 const saved=ledger.submit({requesterId:1,requestKey:'airing',nowMs:100,intent:{state:'ready',anidbId:42,kind:'series',monitorFuture:true,episodeIds:[101,102]}});
 const reopen=()=>{ledger.close();ledger=openRequestLedger(dbPath);return ledger;};
 try{await run({ledger,id:saved.requestId,reopen,dbPath});}finally{ledger.close();await rm(dir,{recursive:true,force:true});}
}
test('future group preference survives mode changes and restart without altering the chosen release',()=>fixture(({ledger,id,reopen})=>{
 assert.equal(ledger.updateReleasePreference(id,0,preference,100).state,'updated');
 const control=ledger.getReleaseControl(id,100);
 ledger.updateReleaseControl(id,control.revision,{mode:'manual',phase:'selecting'},101);
 assert.equal(reopen().getReleaseControl(id,102).preference.group,'SubsPlease');
}));
test('an alternative starts one two-hour deadline which later releases and restart cannot reset',()=>fixture(({ledger,id,reopen})=>{
 ledger.updateReleasePreference(id,0,preference,100);
 const first=ledger.checkPreferredRelease({requestId:id,candidate,preview,releaseState:'airing',nowMs:1000});
 assert.equal(first.reason,'preferred_group_wait');assert.equal(first.retryAtMs,7_201_000);
 const next=reopen().checkPreferredRelease({requestId:id,candidate:{...candidate,guid:'later'},preview,releaseState:'airing',nowMs:100_000});
 assert.equal(next.retryAtMs,first.retryAtMs);
}));
test('preferred release and deadline expiry proceed, while historical and completed work never waits',()=>fixture(({ledger,id})=>{
 ledger.updateReleasePreference(id,0,preference,100);
 const input={requestId:id,candidate,preview,releaseState:'airing',nowMs:1000};
 assert.equal(ledger.checkPreferredRelease({...input,candidate:{...candidate,title:'[SubsPlease] Example - 02 1080p'}}).state,'ready');
 assert.equal(ledger.checkPreferredRelease({...input,preview:{...preview,episodeIds:[101]}}).state,'ready');
 assert.equal(ledger.checkPreferredRelease({...input,releaseState:'completed'}).state,'ready');
 ledger.checkPreferredRelease(input);
 assert.equal(ledger.checkPreferredRelease({...input,nowMs:7_201_001}).state,'ready');
}));
test('expired fallback retains the observed exact torrent and is unavailable before its deadline',()=>fixture(({ledger,id})=>{
 ledger.updateReleasePreference(id,0,preference,100);
 ledger.checkPreferredRelease({requestId:id,candidate,preview,releaseState:'airing',nowMs:1000});
 assert.equal(ledger.getPreferredFallback(id,[102],2000),null);
 assert.equal(ledger.getPreferredFallback(id,[102],7_201_000).preview.torrentHash,preview.torrentHash);
 ledger.closePreferredWaits(id,[102],7_201_100);
 assert.equal(ledger.getPreferredFallback(id,[102],7_201_200),null);
}));

test('a stronger observed fallback replaces a weaker one without extending the original deadline',()=>fixture(({ledger,id})=>{
 ledger.updateReleasePreference(id,0,preference,100);
 const input={requestId:id,candidate:{...candidate,title:'[Other] Example - 02 720p'},preview,releaseState:'airing',nowMs:1000};
 const first=ledger.checkPreferredRelease(input);
 const stronger={...candidate,guid:'better',title:'[Better] Example - 02 1080p'};
 assert.equal(ledger.checkPreferredRelease({...input,candidate:stronger,nowMs:2000}).retryAtMs,first.retryAtMs);
 ledger.checkPreferredRelease({...input,nowMs:3000});
 assert.equal(ledger.getPreferredFallback(id,[102],first.retryAtMs).candidate.guid,'better');
}));
test('intentional group waiting is measured separately from acquisition decision work',()=>fixture(({ledger,id,dbPath})=>{
 ledger.updateReleasePreference(id,0,preference,100);
 const wait=ledger.checkPreferredRelease({requestId:id,candidate,preview,releaseState:'airing',nowMs:1000});
 const queue=openAcquisitionRequestQueue(dbPath);
 try{
   const claim=queue.claimNext({nowMs:1000});queue.recordResult({requestId:id,pass:claim.pass,state:'held',reason:wait.reason,retryAtMs:wait.retryAtMs,checkedMs:1000});
   const next=queue.claimNext({nowMs:7_202_500,priorityRequestId:id});
   queue.recordResult({requestId:id,pass:next.pass,state:'held',reason:'request_fully_available',checkedMs:7_202_500});
   const timing=queue.getDecisionTiming(id);assert.equal(timing.intentionalGroupWaitMs,7_200_000);
   assert.equal(timing.wallElapsedMs,7_201_500);assert.equal(timing.elapsedMs,1500);
 }finally{queue.close();}
}));
