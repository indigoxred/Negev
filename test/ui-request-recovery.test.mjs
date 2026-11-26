import fs from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
import * as selection from '../src/web/public/season-request-selection.mjs';
import * as feedback from '../src/web/public/request-feedback.mjs';
const app=await fs.readFile(new URL('../src/web/public/app.js',import.meta.url),'utf8');
class El {constructor(tag,text='',cls=''){this.tag=tag;this.textContent=text;this.cls=cls;this.children=[];this.listeners={};this.dataset={};this.hidden=false;this.disabled=false;this.open=false;this.classList={add(){},toggle(){}};}append(...items){this.children.push(...items);}setAttribute(){}addEventListener(name,fn){this.listeners[name]=fn;}close(){this.open=false;this.listeners.close?.();}showModal(){if(!this.disabled)this.open=true;}click(){if(!this.disabled)return this.listeners.click?.();}replaceWith(){}remove(){} }
const tick=()=>new Promise(r=>setImmediate(r));
const seriesStart=app.indexOf("    if (data.kind === 'series') {",app.indexOf('// Keep the original control mounted'));
let series=app.slice(seriesStart,app.indexOf("    const requestAction = element('section'",seriesStart));
series=series.replace(/return;\s*}\s*$/, 'return {rows,refresh,trigger,action,feedback,modeActions,submit}; }');
async function fixture({closed=false,related=false,checking=false,pageSuccess=false,batch,keys}={}){const els=[];const data={state:'details',kind:'series',anidbId:1,title:'First',requestsOpen:!closed,episodes:[{id:11,type:'Episode',number:1,availability:'missing'}],nextPage:checking?2:null};const pager={episodes:data.episodes,nextPage:data.nextPage};const posts=[];const panel=new El('section');const context={...selection,...feedback,element:(...args)=>{const e=new El(...args);els.push(e);return e;},document:{createElement:tag=>new El(tag)},data,pager,item:{anidbId:1,title:'First'},notReleased:false,panel,detailActionRow:()=>new El('div'),relatedHeading:{},openSeasonDialog:null,syncSeasonLookup:null,syncSeasonRows:null,refreshRequestAction:null,relatedLoading:false,lastRelatedFailure:null,loadRelated(){},family:{next:()=>null,items:()=>[{anidbId:1,title:'First'},...(related?[{anidbId:2,title:'Second'}]:[])]},state:{releaseSearch:true,user:{id:7}},makeReleaseActions:(element,o)=>{const auto=new El('button'),manual=new El('button');auto.addEventListener('click',o.onAuto);manual.addEventListener('click',o.onManual);return {element:new El('div'),auto,manual};},requestRoute:id=>'#/requests?requestId='+id,relatedDetails:{peek:()=>({state:'details',kind:'series',title:'Second',episodes:data.episodes,nextPage:null}),get:async()=>({})},isCurrentDetail:()=>true,checkingCompleteSeries:checking,loadNextEpisodePage:checking?async()=>{if(pageSuccess)pager.nextPage=null;return pageSuccess;}:null,titleLabel:x=>new El('span',x.title),preferredDisplayTitle:x=>x.title,requestKeys:keys??{pending:()=> 'key',saved(){},rejected(){}},sessionResponses:{current:()=>1,isCurrent:()=>true},api:async(u,o)=>{posts.push(JSON.parse(o.body));return typeof batch==='function'?batch():batch;},refreshTrackingAfterRequest(){},loadRequests(){},openPreviewReleaseRequests(){},openSavedReleaseRequests:jobs=>{context.foregroundJobs=jobs;}};panel.insertBefore=()=>{};const out=vm.runInNewContext('(function(){'+series+'})()',context);await tick();return {...out,els,context,posts,panel};}
const previewFn=app.slice(app.indexOf('async function openPreviewReleaseRequests(jobs)'),app.indexOf('async function openSavedReleaseRequests'));
async function previewFixture(error){const calls=[],opens=[],saved=[];const ctx={state:{releaseSearch:true,user:{id:7}},sessionResponses:{current:()=>1,isCurrent:()=>true},location:{hash:'#/title/1'},api:async(u,o)=>{const id=JSON.parse(o.body).anidbId;calls.push(id);if(id===1)throw error;return {state:'preview',previewId:'p'+id};},releasePreviewSaved:new Map(),releaseDialog:{open:args=>opens.push(args)},preferredDisplayTitle:x=>x.title,message(){},requestFailureMessage:feedback.requestFailureMessage,refreshTrackingAfterRequest(){},loadRequests(){},savedRequestMessage:feedback.savedRequestMessage};vm.runInNewContext(previewFn,ctx);await ctx.openPreviewReleaseRequests([1,2].map(id=>({title:String(id),body:{anidbId:id},saved:()=>saved.push(id)})));await tick();return {calls,opens,saved};}
test('Manual browsing skips an unavailable first installment without saving any request',async()=>{const x=await previewFixture({reason:'already_available',status:409});assert.deepEqual(x.calls,[1,2]);assert.equal(x.opens[0].previewId,'p2');assert.deepEqual(x.saved,[]);});
test('Manual browsing stops after an authentication or authorization failure',async()=>{for(const status of [401,403])assert.deepEqual((await previewFixture({status})).calls,[1]);});
test('partial Auto keeps failed rows and successful receipts in the foreground; retry sends only failed rows',async()=>{const x=await fixture({related:true,batch:{items:[{anidbId:1,status:201,result:{state:'saved',created:true,requestId:91,targetIds:[11]}},{anidbId:2,status:503,result:{reason:'provider_unavailable'}}]}});x.trigger.click();for(const row of x.rows.values())row.input.checked=true;x.refresh();x.modeActions.auto.click();await tick();assert.equal(x.action.open,true);assert.match(x.feedback.textContent,/#91.*could not be saved/);assert.equal(x.context.foregroundJobs,undefined);x.modeActions.auto.click();await tick();assert.deepEqual(Array.from(x.posts[1].seasons,r=>r.anidbId),[2]);});
test('ineligible root does not disable the eligible child chooser or enable the root row',async()=>{const x=await fixture({closed:true,related:true});assert.equal(x.trigger.disabled,false);assert.equal(x.rows.get(1).input.disabled,true);assert.equal(x.rows.get(2).input.disabled,false);});
test('failed complete-series page has an accessible retry outside the closed chooser',async()=>{const x=await fixture({checking:true});const retry=x.els.find(e=>e.textContent==='Continue availability check');assert.equal(retry.hidden,false);assert.ok(x.panel.children.includes(retry));assert.equal(x.rows.get(1).status.selectable,false);});
test('successful advanced paging clears the complete-series gate without reopening the chooser',async()=>{const x=await fixture({checking:true});x.context.pager.nextPage=null;x.context.refreshRequestAction();assert.equal(x.context.checkingCompleteSeries,false);assert.equal(x.trigger.disabled,false);const retry=x.els.find(e=>e.textContent==='Continue availability check');assert.equal(retry.hidden,true);});

test('the HTTP error path rotates a definitively cancelled key, retaining ambiguous and stale response keys',async()=>{
 const {createRequestKeyStore}=await import('../src/web/public/request-key.mjs');const values=new Map();let n=0;
 const keys=createRequestKeyStore({storage:{getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)},createKey:()=>`key-${++n}`});
 const scope={userId:7,anidbId:123};const original=keys.pending(scope);
 let reason='provider_unavailable';const ctx={state:{user:{id:7},csrf:'csrf'},requestKeys:keys,sessionResponses:{current:()=>1,isCurrent:()=>true},cataloguePacers:{},fetch:async()=>({ok:false,status:409,json:async()=>({reason}),headers:{get:()=>null}})};
 const fn=app.slice(app.indexOf('async function api('),app.indexOf('const releasePreviewSaved='));vm.runInNewContext(fn,ctx);
 const send=()=>ctx.api('/api/requests',{method:'POST',body:JSON.stringify({anidbId:123,scope:'installment',requestKey:original})});
 await assert.rejects(send);assert.equal(keys.pending(scope),original);
 reason='request_cancelled';await assert.rejects(send);assert.notEqual(keys.pending(scope),original);
 const fresh=keys.pending(scope);await assert.rejects(send);assert.equal(keys.pending(scope),fresh);
});

test('the visible availability retry finishes the exact bounded page check',async()=>{
 const x=await fixture({checking:true});const retry=x.els.find(e=>e.textContent==='Continue availability check');
 x.context.loadNextEpisodePage=async()=>{x.context.pager.nextPage=null;return true;};retry.click();await tick();
 assert.equal(x.context.checkingCompleteSeries,false);assert.equal(x.trigger.disabled,false);assert.equal(retry.hidden,true);
});
test('complete-series background checking remains bounded and cannot enable unknown targets',async()=>{
 const x=await fixture({checking:true});let reads=0;const retry=x.els.find(e=>e.textContent==='Continue availability check');
 x.context.loadNextEpisodePage=async()=>{reads++;x.context.pager.nextPage++;return true;};retry.click();await tick();
 assert.equal(reads,20);assert.equal(retry.hidden,false);assert.equal(x.context.checkingCompleteSeries,true);assert.equal(x.rows.get(1).input.disabled,true);
});

test('settled watch ownership preparation explains completion without exposing another owner',()=>{
 const start=app.indexOf('      const row = element(',app.indexOf('async function loadPreparations('));
 const fragment=app.slice(start,app.indexOf("      const open = element('a'",start));
 const result=vm.runInNewContext('(function(){'+fragment+'return heading;})()', {item:{state:'complete',reason:'already_monitored_elsewhere',title:'Example'},element:(...args)=>new El(...args),posterImage:()=>new El('img'),titleLabel:()=>new El('span'),requestFailureMessage:feedback.requestFailureMessage});
 assert.equal(result.children[1].textContent,'Future episodes are already monitored. No second request is needed.');
 assert.equal(result.children.some(x=>x.textContent?.includes('Preparing episode details')),false);
});

test('cancelled episode and film-entry submissions rotate only the matching command key',async()=>{
 const {createRequestKeyStore}=await import('../src/web/public/request-key.mjs');
 for(const selected of ['episode-1001','film-entry-1001']){
  const values=new Map();let n=0;const keys=createRequestKeyStore({storage:{getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)},createKey:()=>`key-${++n}`});
  const scopes=['episode-1001','film-entry-1001'].map(selection=>({userId:7,anidbId:123,selection}));const before=scopes.map(scope=>keys.pending(scope));const index=scopes.findIndex(s=>s.selection===selected);
  const ctx={state:{user:{id:7}},requestKeys:keys,sessionResponses:{current:()=>1,isCurrent:()=>true},cataloguePacers:{},fetch:async()=>({ok:false,status:409,json:async()=>({reason:'request_cancelled'}),headers:{get:()=>null}})};
  vm.runInNewContext(app.slice(app.indexOf('async function api('),app.indexOf('const releasePreviewSaved=')),ctx);
  await assert.rejects(()=>ctx.api('/api/requests',{method:'POST',body:JSON.stringify({anidbId:123,scope:'episodes',episodeIds:[1001],requestKey:before[index]})}));
  assert.notEqual(keys.pending(scopes[index]),before[index]);assert.equal(keys.pending(scopes[1-index]),before[1-index]);
 }
});

test('Manual browsing stops when server preparation confirms changed account access',async()=>{
 assert.deepEqual((await previewFixture({reason:'account_access_changed',status:409})).calls,[1]);
});

function realRequestKeys(createRequestKeyStore){
 const values=new Map();let sequence=0;
 return createRequestKeyStore({storage:{getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)},createKey:()=>`batch-key-${++sequence}`});
}
async function deferredBatch(keys){
 let finish;const pending=new Promise(resolve=>{finish=resolve;});
 const x=await fixture({keys,batch:()=>pending});x.trigger.click();x.rows.get(1).input.checked=true;x.refresh();x.modeActions.auto.click();await tick();
 return {...x,finish};
}
test('a delayed cancelled seasonal batch cannot clear a newer key for the same account',async()=>{
 const {createRequestKeyStore}=await import('../src/web/public/request-key.mjs');const keys=realRequestKeys(createRequestKeyStore),scope={userId:7,anidbId:1};
 const x=await deferredBatch(keys),submitted=x.posts[0].seasons[0].requestKey;
 keys.saved(scope);const newer=keys.pending(scope);assert.notEqual(newer,submitted);
 x.finish({items:[{anidbId:1,status:409,result:{reason:'request_cancelled'}}]});await tick();
 assert.equal(keys.pending(scope),newer);
});
test('a delayed seasonal batch cannot clear another account key or mark its old dialog requested',async()=>{
 const {createRequestKeyStore}=await import('../src/web/public/request-key.mjs');
 for(const status of [201,409]){
  const keys=realRequestKeys(createRequestKeyStore),x=await deferredBatch(keys),nextScope={userId:8,anidbId:1};
  const newer=keys.pending(nextScope);x.context.state.user={id:8};
  x.finish({items:[{anidbId:1,status,result:status===201?{requestId:91,state:'saved'}:{reason:'request_cancelled'}}]});await tick();
  assert.equal(keys.pending(nextScope),newer);assert.equal(x.rows.get(1).requested,false);
 }
});
test('a replaced same-account session ignores the old seasonal batch response',async()=>{
 const {createRequestKeyStore}=await import('../src/web/public/request-key.mjs');const keys=realRequestKeys(createRequestKeyStore),scope={userId:7,anidbId:1};
 const x=await deferredBatch(keys),submitted=keys.pending(scope);x.context.sessionResponses.isCurrent=()=>false;
 x.finish({items:[{anidbId:1,status:201,result:{requestId:91,state:'saved'}}]});await tick();
 assert.equal(keys.pending(scope),submitted);assert.equal(x.rows.get(1).requested,false);
});

test('a current seasonal batch rotates only definitively cancelled submitted keys',async()=>{
 const {createRequestKeyStore}=await import('../src/web/public/request-key.mjs');
 for(const reason of ['request_cancelled','provider_unavailable']){
  const keys=realRequestKeys(createRequestKeyStore),scope={userId:7,anidbId:1},x=await deferredBatch(keys);
  const submitted=x.posts[0].seasons[0].requestKey;
  x.finish({items:[{anidbId:1,status:409,result:{reason}}]});await tick();
  assert.equal(keys.pending(scope)===submitted,reason!=='request_cancelled');
 }
});

test('a delayed successful seasonal batch cannot clear a newer uncertain request key',async()=>{
 const {createRequestKeyStore}=await import('../src/web/public/request-key.mjs');
 const keys=realRequestKeys(createRequestKeyStore),scope={userId:7,anidbId:1},x=await deferredBatch(keys);
 const submitted=x.posts[0].seasons[0].requestKey;
 keys.rejected(scope,{reason:'request_cancelled'},submitted);const newer=keys.pending(scope);assert.notEqual(newer,submitted);
 x.finish({items:[{anidbId:1,status:201,result:{state:'saved',requestId:91,targetIds:[]}}]});await tick();
 assert.equal(keys.pending(scope),newer);
});
