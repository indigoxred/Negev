import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openRequestLedger} from '../src/requests/request-ledger.mjs';
import {createHeldRequestSubmitter} from '../src/requests/submit-held-request.mjs';
import {createReleasePreviews} from '../src/requests/release-previews.mjs';

async function fixture(t,{airing=false}={}) {
 const dir=await mkdtemp(path.join(tmpdir(),'negev-preview-retry-'));
 const requests=openRequestLedger(path.join(dir,'db.sqlite'));
 t.after(async()=>{requests.close();await rm(dir,{recursive:true,force:true});});
 const detail={state:'details',anidbId:42,title:'Known installment',kind:airing?'series':'movie',restricted:false,complete:true,page:1,total:1,nextPage:null,airDate:'2026-10-01',endDate:airing?null:'2026-10-01',episodeCount:airing?12:1,episodes:[{id:99,number:1,type:'Episode',title:'First',airDate:'2026-10-01'}]};
 const input={requesterId:7,anidbId:42,scope:'installment',requestKey:'original'};
 let available=false,allowed=true;const wakes=[];let inspections=0;
 const prepare=createHeldRequestSubmitter({ledger:{...requests,submit:submission=>({state:'prepared',submission})},confirmKnownTitle:async()=>true,loadDetail:async()=>detail,now:()=>1000,today:()=> '2026-11-21',authorizeRequester:()=>({active:allowed,adultAllowed:true}),recentlyAvailable:()=>available});
 const sessions=createReleasePreviews({requests,prepare,now:()=>1000,wake:id=>wakes.push(id),selectionOptions:{
  discoverCandidates:async()=>({state:'candidates',releaseState:airing?'airing':'completed',items:[{guid:'film',indexerId:1,title:'[G] Known installment BD 1080p',size:100,seeders:10,proxyUrl:'https://private.invalid/secret'}]}),
  previewCandidate:async()=>{inspections++;return {state:'preflight',torrentHash:'b'.repeat(40),episodeIds:[99],files:[{name:'film.mkv',size:100,episodeIds:[99]}]};},
  readPublicCoverage:async()=>({availableEpisodeIds:available?[99]:[],uncertainEpisodeIds:[]}),loadDetail:async()=>detail}});
 const open=async(data=input)=>{const opened=await sessions.open(data);assert.equal(opened.state,'preview',JSON.stringify(opened));const id=sessions.access(opened.previewId,data.requesterId);const found=await sessions.selection.search(id);return {opened,id,token:found.items[0].token};};
 const choose=ctx=>sessions.command(ctx.opened.previewId,7,{action:'choose',revision:1,token:ctx.token});
 return {requests,sessions,input,wakes,open,choose,inspections:()=>inspections,available:()=>available=true,revoke:()=>allowed=false};
}

test('opening the same legitimate submission returns its existing request without editing its choice',async t=>{
 const x=await fixture(t);const a=await x.open();const saved=await x.choose(a);const before=x.requests.getReleaseControl(saved.requestId,1000);
 const repeat=await x.sessions.open(x.input);assert.deepEqual(repeat,{state:'existing',requestId:saved.requestId,created:false});
 assert.deepEqual(x.requests.getReleaseControl(saved.requestId,1000),before);assert.equal(x.requests.listRequests({requesterId:7}).items.length,1);assert.deepEqual(x.wakes,[saved.requestId]);
});

test('independent simultaneous previews return the one saved request through real idempotency checks',async t=>{
 const x=await fixture(t),a=await x.open(),b=await x.open();const [first,second]=await Promise.all([x.choose(a),x.choose(b)]);
 assert.equal(first.state,'updated');assert.equal(second.state,'updated',JSON.stringify(second));assert.equal(second.requestId,first.requestId);assert.equal([first,second].filter(x=>x.created).length,1);
 assert.equal(x.requests.listRequests({requesterId:7}).items.length,1);assert.deepEqual(x.wakes,[first.requestId]);
});

test('a second open preview succeeds after the first choice becomes available without inspecting again',async t=>{
 const x=await fixture(t),a=await x.open(),b=await x.open();const saved=await x.choose(a);x.available();const count=x.inspections();
 const repeated=await x.choose(b);assert.equal(repeated.state,'updated',JSON.stringify(repeated));assert.equal(repeated.created,false);assert.equal(repeated.requestId,saved.requestId);assert.equal(x.inspections(),count);assert.deepEqual(x.wakes,[saved.requestId]);
});

test('a same-user Airing watch with a new request key returns existing success and preserves the group',async t=>{
 const x=await fixture(t,{airing:true}),a=await x.open();const saved=await x.choose(a);
 x.requests.updateReleasePreference(saved.requestId,saved.control.revision,{group:'SubsPlease',audio:'japanese',knownEpisodeIds:[99],createdMs:1000},1000);
 const before=x.requests.getReleaseControl(saved.requestId,1000);
 const repeated=await x.sessions.open({...x.input,requestKey:'new-key'});assert.deepEqual(repeated,{state:'existing',requestId:saved.requestId,created:false});
 assert.deepEqual(x.requests.getReleaseControl(saved.requestId,1000),before);assert.deepEqual(x.wakes,[saved.requestId]);
});

test('conflicting commands, cancelled requests and another user watch never become existing success',async t=>{
 const x=await fixture(t,{airing:true}),a=await x.open();const saved=await x.choose(a);
 assert.equal((await x.sessions.open({...x.input,anidbId:43})).reason,'idempotency_key_conflict');
 assert.equal((await x.sessions.open({...x.input,scope:'episodes',episodeIds:[99]})).reason,'idempotency_key_conflict');
 const other=await x.sessions.open({...x.input,requesterId:8,requestKey:'another-user'});assert.equal(other.reason,'already_monitored_elsewhere');assert.equal(other.requestId,undefined);
 assert.equal(x.requests.cancelRequest({requesterId:7,requestId:saved.requestId,nowMs:1100}).state,'cancelled');
 assert.equal((await x.sessions.open(x.input)).reason,'request_cancelled');assert.deepEqual(x.wakes,[saved.requestId]);
});

test('changed authorization still prevents a new preview commit',async t=>{
 const x=await fixture(t),a=await x.open();x.revoke();const result=await x.choose(a);assert.equal(result.reason,'account_access_changed');assert.equal(x.requests.listRequests({requesterId:7}).items.length,0);assert.deepEqual(x.wakes,[]);
});

test('a legitimate repeat does not consume or require a free preview slot',async t=>{
 const x=await fixture(t),first=await x.open();const saved=await x.choose(first);
 for(let n=0;n<10;n++)await x.open({...x.input,requestKey:'draft-'+n});
 assert.equal((await x.sessions.open({...x.input,requestKey:'overflow'})).reason,'release_preview_limit');
 assert.deepEqual(await x.sessions.open(x.input),{state:'existing',requestId:saved.requestId,created:false});assert.deepEqual(x.wakes,[saved.requestId]);
});

test('replaying a committed preview reads current control and respects later cancellation',async t=>{
 const x=await fixture(t),a=await x.open();const saved=await x.choose(a);
 const revision=saved.control.revision;x.requests.updateReleasePreference(saved.requestId,revision,null,1000);
 const repeat=await x.choose(a);assert.equal(repeat.control.revision,revision+1);assert.equal(repeat.created,false);
 x.requests.cancelRequest({requesterId:7,requestId:saved.requestId,nowMs:1100});assert.equal((await x.choose(a)).reason,'request_cancelled');assert.deepEqual(x.wakes,[saved.requestId]);
});

test('a request saved during the final coverage read wins over newly positive ownership',async t=>{
 const x=await fixture(t);let committed=null,reads=0;
 const prepare=createHeldRequestSubmitter({ledger:{...x.requests,submit:submission=>({state:'prepared',submission})},confirmKnownTitle:async()=>true,loadDetail:async()=>({state:'details',anidbId:42,title:'Known installment',kind:'movie',restricted:false,complete:true,page:1,total:1,nextPage:null,airDate:'2020-01-01',endDate:'2020-01-01',episodeCount:1,episodes:[{id:99,number:1,type:'Episode',title:'Film',airDate:'2020-01-01'}]}),now:()=>1000,today:()=> '2026-11-21',authorizeRequester:()=>({active:true,adultAllowed:true})});
 const commandKey=JSON.stringify([42,'installment',null]);
 const sessions=createReleasePreviews({requests:x.requests,prepare,now:()=>1000,wake:id=>x.wakes.push(id),selectionOptions:{discoverCandidates:async()=>({state:'candidates',releaseState:'completed',items:[{guid:'r',indexerId:1,title:'Known installment BD 1080p',size:100,seeders:10}]}),previewCandidate:async()=>({state:'preflight',torrentHash:'c'.repeat(40),episodeIds:[99],files:[{name:'film.mkv',size:100,episodeIds:[99]}]}),readPublicCoverage:async()=>{
  if(++reads===2){committed=x.requests.submit({...x.input,commandKey,intent:{state:'ready',anidbId:42,kind:'movie',monitorFuture:false,episodeIds:[99]},nowMs:1000});return {availableEpisodeIds:[99],uncertainEpisodeIds:[]};}return {availableEpisodeIds:[],uncertainEpisodeIds:[]};
 }}});
 const opened=await sessions.open(x.input),id=sessions.access(opened.previewId,7),found=await sessions.selection.search(id);
 const result=await sessions.command(opened.previewId,7,{action:'choose',revision:1,token:found.items[0].token});assert.equal(result.state,'updated',JSON.stringify(result));assert.equal(result.requestId,committed.requestId);assert.equal(result.created,false);assert.deepEqual(x.wakes,[]);assert.equal(x.requests.listRequests({requesterId:7}).items.length,1);
});
