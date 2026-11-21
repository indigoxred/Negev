import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { createReleaseSelection } from '../src/acquisition/release-selection.mjs';
async function fixture(run) {
  const dir=await mkdtemp(path.join(tmpdir(),'negev-selection-service-'));
  const requests=openRequestLedger(path.join(dir,'state.sqlite'));
  const saved=requests.submit({requesterId:1,requestKey:'test',releaseMode:'manual',nowMs:100,
    intent:{state:'ready',anidbId:42,kind:'series',monitorFuture:false,episodeIds:[1,2]}});
  let clock=100,wakes=0,providerFailure=false,incomplete=false,available=[];const inspected=[];let inspectHook=async()=>null;let groupReader=async()=>null;
  const items=['WEB','BD'].map((source,i)=>({guid:`release-${i}`,indexerId:1,title:`[Group] Example batch ${source} 1080p`,
    size:1000,seeders:20,evidence:'unverified',proxyUrl:'https://private/?apikey=secret'}));
  const previewCandidate=async({requestId,candidate})=>{inspected.push(candidate.guid);const failure=await inspectHook();if(failure)return failure;return {state:'preflight',requestId,anidbId:42,
    torrentHash:(candidate.guid==='release-0'?'a':'b').repeat(40),episodeIds:[1,2],
    files:[{name:'a.mkv',size:500,episodeIds:[1]},{name:'b.mkv',size:500,episodeIds:[2]}],
    correspondence:{files:['a.mkv','b.mkv'].map(name=>({name,size:500,state:candidate.guid==='release-0'?'likely':'unknown'}))}};};
  const make=()=>createReleaseSelection({readGroupRegistry:()=>groupReader(),requests,now:()=>clock,wake:()=>{wakes++;},previewCandidate,
    discoverCandidates:async()=>providerFailure?{state:'held',reason:'release_search_unavailable'}:
      {state:'candidates',requestId:saved.requestId,anidbId:42,releaseState:'completed',items,searchIncomplete:incomplete},
    readPublicCoverage:async()=>({targetCount:2,verifiedTargets:available.length,availableEpisodeIds:available,uncertainEpisodeIds:[]})});
  try{await run({service:make(),requests,id:saved.requestId,advance:value=>{clock=value},
    fail:()=>{providerFailure=true},wakes:()=>wakes,make,items,inspected,setInspectHook:fn=>inspectHook=fn,setIncomplete:()=>{incomplete=true},setAvailable:ids=>{available=ids},setGroupReader:fn=>{groupReader=fn}});}
  finally{requests.close();await rm(dir,{recursive:true,force:true});}
}
test('manual search is read-only, has opaque receipts, and choosing pins the exact inspected torrent',()=>fixture(async({service,requests,id,wakes})=>{
  const result=await service.search(id);assert.equal(JSON.stringify(result).includes('secret'),false);assert.equal(wakes(),0);
  const before=service.snapshot(id);
  const selected=result.items.find(c=>c.guid==='release-0');
  const preview=await service.inspect(id,selected.token);assert.equal(preview.torrentHash,'a'.repeat(40));
  const chosen=await service.choose(id,selected.token,before.revision);
  assert.equal(chosen.state,'updated');assert.equal(requests.getReleaseControl(id,100).selection.preview.torrentHash,'a'.repeat(40));
  assert.equal((await service.choose(id,result.items[1].token,before.revision)).reason,'stale_release_selection');
  assert.equal(wakes(),1);
}));
test('Auto-only proposal survives a new service instance and expires to registered choice',()=>fixture(async({service,id,advance,make})=>{
  const begun=service.begin(id,'auto',service.snapshot(id).revision);
  const result=await service.auto(id,begun.control.revision);
  assert.equal(result.control.phase,'proposal');assert.match(result.control.proposal.benefit,/Blu-ray/);
  const restarted=make();advance(300101);
  assert.equal(restarted.snapshot(id).selection.candidate.guid,'release-0');
}));
test('an indexer failure cannot leave an automatic prompt waiting forever',()=>fixture(async({service,id,advance,fail})=>{
  const begun=service.begin(id,'auto',service.snapshot(id).revision);fail();
  assert.equal((await service.auto(id,begun.control.revision)).reason,'release_search_unavailable');
  advance(300101);assert.equal(service.snapshot(id).phase,'consumed');
}));
test('expired receipts cannot replace a durable manual choice',()=>fixture(async({service,id,advance})=>{
  const result=await service.search(id);advance(600101);
  assert.equal((await service.choose(id,result.items[0].token,1)).reason,'release_search_expired');
  assert.equal(service.snapshot(id).phase,'selecting');
}));
test('Auto uses private trusted ranking before the three-preview cap',()=>fixture(async({service,id,items,inspected})=>{
 items.splice(0,items.length,...[0,1,2,3].map(i=>({guid:`release-${i}`,indexerId:1,
   title:`[G${i}] Example batch WEB 1080p`,size:1000,seeders:20,trusted:i===3,evidence:'unverified'})));
 const begun=service.begin(id,'auto',service.snapshot(id).revision);
 await service.auto(id,begun.control.revision);assert.equal(inspected[0],'release-3');
}));
test('Auto cannot pin a low-resolution release from an incomplete search',()=>fixture(async({service,id,items,setIncomplete})=>{
 items.forEach(c=>{c.title=c.title.replace('1080p','480p')});setIncomplete();
 const begun=service.begin(id,'auto',service.snapshot(id).revision);
 const result=await service.auto(id,begun.control.revision);assert.equal(result.control.phase,'consumed');
}));
test('manual inspection and selection cannot re-request exact already available episodes',()=>fixture(async({service,id,setAvailable,wakes})=>{
 const result=await service.search(id);setAvailable([1,2]);
 const preview=await service.inspect(id,result.items[0].token);assert.equal(preview.selectionStatus,'already_available');
 assert.equal((await service.choose(id,result.items[0].token,1)).reason,'target_already_available');assert.equal(wakes(),0);
}));

test('inspection separates advertised packs from checked requested-episode coverage',()=>fixture(async({service,id})=>{
 const result=await service.search(id);assert.equal(result.items[0].coverageKind,'advertised_pack');
 const preview=await service.inspect(id,result.items[0].token);
 assert.deepEqual(preview.coverage,{coveredEpisodeCount:2,requestedEpisodeCount:2,completeRequested:true});
}));


test('a transient inspection failure can be retried on the same receipt and only success is cached',()=>fixture(async x=>{
 const found=await x.service.search(x.id),token=found.items[0].token;
 x.setInspectHook(async()=>({state:'held',reason:'torrent_preflight_unavailable'}));
 assert.equal((await x.service.inspect(x.id,token)).reason,'torrent_preflight_unavailable');assert.equal(x.inspected.length,1);
 x.setInspectHook(async()=>null);assert.equal((await x.service.inspect(x.id,token)).state,'preflight');assert.equal(x.inspected.length,2);
 assert.equal((await x.service.inspect(x.id,token)).state,'preflight');assert.equal(x.inspected.length,2);assert.equal(x.wakes(),0);
}));

test('simultaneous inspections share the pending lookup without saving a request or wake',()=>fixture(async x=>{
 let release;const gate=new Promise(r=>release=r);x.setInspectHook(()=>gate);
 const found=await x.service.search(x.id),token=found.items[0].token;
 const a=x.service.inspect(x.id,token),b=x.service.inspect(x.id,token);await Promise.resolve();release(null);
 assert.equal((await a).state,'preflight');assert.equal((await b).state,'preflight');assert.equal(x.inspected.length,1);assert.equal(x.wakes(),0);
}));

test('global group annotations are display-only and a provider failure leaves releases selectable',()=>fixture(async x=>{
 let calls=0;x.setGroupReader(async()=>{calls++;return{match:name=>name==='Group'?{state:'listed',scope:'global',groupId:123,name:'Group'}:null}});
 const found=await x.service.search(x.id);assert.equal(calls,1);assert.equal(found.items[0].groupRegistration.groupId,123);assert.equal(found.items[0].eligible,true);assert.equal(x.inspected.length,0);assert.equal(x.wakes(),0);
 x.setGroupReader(async()=>{throw Error('unavailable')});const fallback=await x.service.search(x.id);assert.equal(fallback.state,'candidates');assert.equal(fallback.items[0].groupRegistration,null);assert.equal(fallback.items[0].eligible,true);
}));


test('a rejected release can expose files for inspection but cannot be chosen or wake acquisition',()=>fixture(async x=>{
 x.setInspectHook(async()=>({state:'held',reason:'release_title_mismatch',inspectedFiles:[{name:'Other S02E01.mkv',size:500,type:'video'}]}));
 const found=await x.service.search(x.id),token=found.items[0].token;
 const result=await x.service.inspect(x.id,token);assert.equal(result.state,'inspection');assert.equal(result.selectionStatus,'rejected');assert.equal(result.files[0].name,'Other S02E01.mkv');
 const before=x.service.snapshot(x.id);const chosen=await x.service.choose(x.id,token,before.revision);
 assert.equal(chosen.state,'held');assert.equal(chosen.reason,'release_title_mismatch');assert.deepEqual(x.service.snapshot(x.id),before);assert.equal(x.wakes(),0);
}));
