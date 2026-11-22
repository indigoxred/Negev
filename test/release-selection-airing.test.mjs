import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { openAcquisitionLedger } from '../src/acquisition/acquisition-ledger.mjs';
import { createReleaseSelection } from '../src/acquisition/release-selection.mjs';
async function fixture(run){
 const dir=await mkdtemp(path.join(tmpdir(),'negev-airing-selection-')),dbPath=path.join(dir,'state.sqlite');
 const requests=openRequestLedger(dbPath),acquisitions=openAcquisitionLedger(dbPath);const now=Date.UTC(2026,10,20,12);
 const requestId=requests.submit({requesterId:1,requestKey:'watch',releaseMode:'manual',nowMs:now,
   intent:{state:'ready',anidbId:42,kind:'series',monitorFuture:true,episodeIds:[101,102]}}).requestId;
 let releaseState='airing',group='SubsPlease',overrideTitle=null;
 const candidate=()=>({guid:'release',indexerId:1,title:overrideTitle??`${group?'['+group+'] ':''}Example - 02 WEB 1080p`,size:1000,seeders:20,evidence:'unverified'});
 const preview={state:'preflight',requestId,anidbId:42,torrentHash:'a'.repeat(40),episodeIds:[102],files:[{name:'Example - 02.mkv',size:1000,episodeIds:[102]}]};
 const make=()=>createReleaseSelection({requests,now:()=>now,
   discoverCandidates:async()=>({state:'candidates',requestId,anidbId:42,releaseState,items:[candidate()]}),
   previewCandidate:async()=>preview,readPublicCoverage:async()=>({targetCount:2,verifiedTargets:0,availableEpisodeIds:[]}),
   loadDetail:async()=>({state:'details',kind:'series',airDate:'2026-10-01',endDate:'2026-12-30',episodeCount:12,episodes:[{id:101,type:'Episode',airDate:'2026-11-10'}]})});
 try{await run({service:make(),requests,acquisitions,requestId,now,candidate,preview,make,
   setState:value=>{releaseState=value},setGroup:value=>{group=value},setTitle:value=>{overrideTitle=value}});}
 finally{requests.close();acquisitions.close();await rm(dir,{recursive:true,force:true});}
}
test('confirmed Airing manual choice saves its future group atomically and survives a new service',()=>fixture(async({service,requests,requestId,make})=>{
 const found=await service.search(requestId);assert.equal(found.confirmedAiring,true);
 const chosen=await service.choose(requestId,found.items[0].token,1,true);assert.equal(chosen.state,'updated');
 assert.equal(chosen.control.preference.group,'SubsPlease');assert.deepEqual(chosen.control.preference.knownEpisodeIds,[101,102]);
 assert.equal((await make().context(requestId)).preferredGroup,'SubsPlease');assert.equal(requests.getReleaseControl(requestId).preference.group,'SubsPlease');
}));
test('completed metadata and unknown groups cannot silently create a future preference',()=>fixture(async({service,requestId,setState,setGroup,make})=>{
 setState('completed');let found=await service.search(requestId);assert.equal(found.confirmedAiring,false);
 assert.equal((await service.choose(requestId,found.items[0].token,1,true)).reason,'title_not_airing');
 setState('airing');setGroup('');service=make();found=await service.search(requestId);
 assert.equal((await service.choose(requestId,found.items[0].token,1,true)).reason,'release_group_unavailable');
}));
test('future group can be edited or cleared while an existing exact attempt remains reserved',()=>fixture(async({service,requests,acquisitions,requestId,now,candidate,preview})=>{
 const found=await service.search(requestId),chosen=await service.choose(requestId,found.items[0].token,1,true);
 assert.equal(acquisitions.reserve({requestId,candidate:candidate(),episodeIds:[102],preparedHash:preview.torrentHash,plannedFiles:preview.files,nowMs:now}).state,'reserved');
 const edited=await service.setPreference(requestId,'Erai-raws',chosen.control.revision);assert.equal(edited.state,'updated');
 assert.equal(edited.control.selection.preview.torrentHash,preview.torrentHash);
 assert.equal(edited.control.preference.group,'Erai-raws');
 const cleared=await service.setPreference(requestId,null,edited.control.revision);assert.equal(cleared.state,'updated');
 assert.equal(requests.getReleaseControl(requestId).preference,null);
}));
test('explicit English dub and UHD manual filters do not change the automatic policy',()=>fixture(async({service,requestId,setTitle})=>{
 setTitle('[G] Example - 02 English Dub BD 2160p');
 assert.equal((await service.search(requestId,undefined,0,{quality:'anything',audio:'english'})).reason,'invalid_release_filters');
 assert.equal((await service.search(requestId)).items.length,0);
 const manual=await service.search(requestId,undefined,0,{quality:'bd1080',audio:'english'});assert.equal(manual.items[0].eligible,true);
 const begun=service.begin(requestId,'auto',1),automatic=await service.auto(requestId,begun.control.revision);
 assert.equal(automatic.control.phase,'consumed');
 const again=service.begin(requestId,'manual',automatic.control.revision);
 const choice=await service.choose(requestId,manual.items[0].token,again.control.revision,false);
 assert.equal(choice.state,'updated');assert.equal(choice.control.selection.candidate.selectionPolicy.allowEnglishDub,true);
 assert.equal(choice.control.selection.candidate.selectionPolicy.allowUhd,true);
}));

test('a consumed airing choice retains editable preference without reopening selection or replacing its exact attempt',()=>fixture(async({service,requests,acquisitions,requestId,now,candidate,preview,make})=>{
 const found=await service.search(requestId),chosen=await service.choose(requestId,found.items[0].token,1,true);
 const attempt=acquisitions.reserve({requestId,candidate:candidate(),episodeIds:[102],preparedHash:preview.torrentHash,plannedFiles:preview.files,nowMs:now});
 assert.equal(attempt.state,'reserved');assert.equal(requests.consumeReleaseChoice(requestId,chosen.control.revision),true);
 const current=requests.getReleaseControl(requestId),restarted=make();assert.equal(current.phase,'consumed');
 const edited=await restarted.setPreference(requestId,'Erai-raws',current.revision,'dual');assert.equal(edited.state,'updated');assert.equal(edited.control.phase,'consumed');assert.equal(edited.control.preference.audio,'dual');
 assert.equal(acquisitions.getAttempt(attempt.attemptId).status,'reserved');
 const cleared=await restarted.setPreference(requestId,null,edited.control.revision);assert.equal(cleared.control.preference,null);assert.equal(cleared.control.phase,'consumed');
}));
