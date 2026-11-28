import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openRequestLedger} from '../src/requests/request-ledger.mjs';
import {createReleasePreviews} from '../src/requests/release-previews.mjs';
const intent={state:'ready',anidbId:123,kind:'series',title:'Example',episodeIds:[1,2],monitorFuture:true};
const candidate={guid:'release',indexerId:1,title:'[Group] Example - 01 [1080p]',size:100,seeders:10};
const preview={state:'preflight',torrentHash:'a'.repeat(40),episodeIds:[1],files:[{name:'example.mkv',size:100,episodeIds:[1]}]};
async function setup(t){const dir=await mkdtemp(path.join(tmpdir(),'negev-preview-'));const requests=openRequestLedger(path.join(dir,'db.sqlite'));t.after(async()=>{requests.close();await rm(dir,{recursive:true,force:true});});let clock=1000;let allowed=true;let available=[];let coverageReads=0,expireAtRead=Infinity;const wakes=[];
const prepare=async input=>allowed?{state:'prepared',submission:{...input,commandKey:'exact',intent:{...intent,anidbId:input.anidbId},nowMs:clock}}:{state:'held',reason:'account_access_changed'};
const sessions=createReleasePreviews({requests,prepare,now:()=>clock,wake:id=>wakes.push(id),selectionOptions:{discoverCandidates:async()=>({state:'candidates',releaseState:'airing',items:[candidate]}),previewCandidate:async()=>preview,readPublicCoverage:async()=>{if(++coverageReads===expireAtRead)clock+=600001;return {availableEpisodeIds:available,uncertainEpisodeIds:[]};},loadDetail:async()=>({state:'details',kind:'series',endDate:null,startDate:'2026-01-01'})}});
const input={requesterId:7,anidbId:123,scope:'installment',requestKey:'new'};
return {requests,sessions,input,wakes,expire:()=>clock+=600001,revoke:()=>allowed=false,setAvailable:ids=>available=ids,expireAtCoverage:n=>expireAtRead=n};}
test('abandoned previews create no request, watch or wake; expiry and ownership are enforced',async t=>{const x=await setup(t);const opened=await x.sessions.open(x.input);assert.equal(opened.state,'preview');assert.equal(x.requests.listRequests({requesterId:7}).items.length,0);assert.equal(x.sessions.access(opened.previewId,8),null);assert.ok(x.sessions.access(opened.previewId,7));x.expire();assert.equal(x.sessions.access(opened.previewId,7),null);assert.deepEqual(x.wakes,[]);assert.deepEqual(x.requests.listActiveAirings(),[]);});
test('exact Grab atomically commits once and keeps its choice before wake',async t=>{const x=await setup(t);const opened=await x.sessions.open(x.input);const id=x.sessions.access(opened.previewId,7);const found=await x.sessions.selection.search(id);const token=found.items[0].token;const revision=x.sessions.selection.snapshot(id).revision;const [a,b]=await Promise.all([x.sessions.command(opened.previewId,7,{action:'choose',token,revision}),x.sessions.command(opened.previewId,7,{action:'choose',token,revision})]);assert.ok(a.requestId);assert.equal(b.requestId,a.requestId);assert.equal(x.requests.listRequests({requesterId:7}).items.length,1);assert.equal(x.requests.getReleaseControl(a.requestId,1000).selection.preview.torrentHash,preview.torrentHash);assert.deepEqual(x.wakes,[a.requestId]);});
test('commit rechecks permission and preserves existing real request',async t=>{const x=await setup(t);const existing=x.requests.submit({...x.input,requestKey:'existing',intent,nowMs:1000});const opened=await x.sessions.open(x.input);const id=x.sessions.access(opened.previewId,7);const found=await x.sessions.selection.search(id);x.revoke();const result=await x.sessions.command(opened.previewId,7,{action:'choose',token:found.items[0].token,revision:1});assert.equal(result.reason,'account_access_changed');assert.deepEqual(x.requests.getRequest(existing.requestId).episodeIds,[1,2]);assert.equal(x.requests.listRequests({requesterId:7}).items.length,1);});

test('each preview remains independent when another installment is committed',async t=>{const x=await setup(t);const a=await x.sessions.open(x.input);const b=await x.sessions.open({...x.input,requestKey:'other'});const id=x.sessions.access(a.previewId,7);const found=await x.sessions.selection.search(id);await x.sessions.command(a.previewId,7,{action:'choose',revision:1,token:found.items[0].token});assert.equal(x.requests.listRequests({requesterId:7}).items.length,1);assert.equal(x.sessions.selection.snapshot(x.sessions.access(b.previewId,7)).phase,'selecting');});
test('fresh ownership after inspection blocks a preview commit',async t=>{const x=await setup(t);const opened=await x.sessions.open(x.input);const id=x.sessions.access(opened.previewId,7);const found=await x.sessions.selection.search(id);await x.sessions.selection.inspect(id,found.items[0].token);x.setAvailable([1]);const result=await x.sessions.command(opened.previewId,7,{action:'choose',revision:1,token:found.items[0].token});assert.equal(result.reason,'target_already_available');assert.equal(x.requests.listRequests({requesterId:7}).items.length,0);assert.deepEqual(x.wakes,[]);});
test('explicit Auto-Pick commits its durable choice once',async t=>{const x=await setup(t);const opened=await x.sessions.open(x.input);const begun=await x.sessions.command(opened.previewId,7,{action:'begin',mode:'auto',revision:1});assert.equal(x.requests.listRequests({requesterId:7}).items.length,0);const saved=await x.sessions.command(opened.previewId,7,{action:'auto',revision:begun.control.revision});assert.ok(saved.requestId);assert.deepEqual(x.wakes,[saved.requestId]);});
test('invalid initial choice rolls back request and watch creation',async t=>{const x=await setup(t);assert.throws(()=>x.requests.submit({...x.input,intent,nowMs:1000,initialReleaseControl:{mode:'manual',phase:'chosen',selection:{}}}),/Invalid initial/);assert.equal(x.requests.listRequests({requesterId:7}).items.length,0);assert.deepEqual(x.requests.listActiveAirings(),[]);});

test('expiry while checking final coverage prevents the commit',async t=>{const x=await setup(t);const opened=await x.sessions.open(x.input);const id=x.sessions.access(opened.previewId,7);const found=await x.sessions.selection.search(id);x.expireAtCoverage(2);const result=await x.sessions.command(opened.previewId,7,{action:'choose',revision:1,token:found.items[0].token});assert.equal(result.reason,'release_preview_expired');assert.equal(x.requests.listRequests({requesterId:7}).items.length,0);});

test('two separate preview sessions with the same request key commit one durable request',async t=>{
 const x=await setup(t);const first=await x.sessions.open(x.input),second=await x.sessions.open(x.input);
 const select=async opened=>{const id=x.sessions.access(opened.previewId,7);const found=await x.sessions.selection.search(id);return x.sessions.command(opened.previewId,7,{action:'choose',revision:1,token:found.items[0].token});};
 const [a,b]=await Promise.all([select(first),select(second)]);
 assert.ok(a.requestId);assert.equal(b.requestId,a.requestId);assert.equal(x.requests.listRequests({requesterId:7}).items.length,1);assert.deepEqual(x.wakes,[a.requestId]);
});

test('committed preview receipts do not consume draft quotas and replay remains idempotent',async t=>{
 const x=await setup(t);const receipts=[];
 for(let n=0;n<11;n++){
  const opened=await x.sessions.open({...x.input,anidbId:123+n,requestKey:'key'+n});
  assert.equal(opened.state,'preview',`committed receipts must not block draft ${n+1}`);
  const begin=await x.sessions.command(opened.previewId,7,{action:'begin',mode:'auto',revision:1});
  const saved=await x.sessions.command(opened.previewId,7,{action:'auto',revision:begin.control.revision});
  assert.ok(saved.requestId);receipts.push({opened,saved});
 }
 const first=receipts[0];const replay=await x.sessions.command(first.opened.previewId,7,{action:'auto',revision:2});
 assert.equal(replay.requestId,first.saved.requestId);assert.equal(x.requests.listRequests({requesterId:7}).items.length,11);
 for(let n=0;n<10;n++)assert.equal((await x.sessions.open({...x.input,requestKey:'draft'+n})).state,'preview');
 assert.equal((await x.sessions.open({...x.input,requestKey:'excess'})).reason,'release_preview_limit');
 x.expire();assert.equal(x.sessions.access(first.opened.previewId,7),null);
 assert.equal((await x.sessions.open({...x.input,requestKey:'after-expiry'})).state,'preview');
});


test('receipt cache is bounded separately from active draft capacity',async t=>{
 const x=await setup(t);let first,last;
 for(let n=0;n<102;n++){
  const opened=await x.sessions.open({...x.input,anidbId:123+n,requestKey:'receipt'+n});assert.equal(opened.state,'preview');
  const begin=await x.sessions.command(opened.previewId,7,{action:'begin',mode:'auto',revision:1});
  assert.ok((await x.sessions.command(opened.previewId,7,{action:'auto',revision:begin.control.revision})).requestId);
  first??=opened.previewId;last=opened.previewId;
 }
 assert.equal(x.sessions.access(first,7),null);
 assert.ok(x.sessions.access(last,7));
 assert.ok((await x.sessions.command(last,7,{action:'auto',revision:2})).requestId);
});
test('preview creation applies per-call authorization after preparation',async t=>{
 const x=await setup(t);const result=await x.sessions.open(x.input,async()=>({state:'held',reason:'account_access_changed'}));
 assert.equal(result.reason,'account_access_changed');assert.equal(x.requests.listRequests({requesterId:7}).items.length,0);assert.deepEqual(x.wakes,[]);
});
test('preview Auto commit authorizes immediately before creating a durable request',async t=>{
 const x=await setup(t);const opened=await x.sessions.open(x.input);const begun=await x.sessions.command(opened.previewId,7,{action:'begin',mode:'auto',revision:1});
 const result=await x.sessions.command(opened.previewId,7,{action:'auto',revision:begun.control.revision},async()=>({state:'held',reason:'account_access_changed'}));
 assert.equal(result.reason,'account_access_changed');assert.equal(x.requests.listRequests({requesterId:7}).items.length,0);assert.deepEqual(x.wakes,[]);
});
test('preview Grab reauthorizes after final coverage and rolls back its draft when access changes',async t=>{
 const x=await setup(t);const opened=await x.sessions.open(x.input);const id=x.sessions.access(opened.previewId,7);const found=await x.sessions.selection.search(id);let authorizations=0;
 const result=await x.sessions.command(opened.previewId,7,{action:'choose',token:found.items[0].token,revision:1},async()=>++authorizations===1?null:{state:'held',reason:'account_access_changed'});
 assert.equal(result.reason,'account_access_changed');assert.equal(authorizations,2);assert.equal(x.sessions.selection.snapshot(id).phase,'selecting');assert.equal(x.requests.listRequests({requesterId:7}).items.length,0);assert.deepEqual(x.wakes,[]);
});
