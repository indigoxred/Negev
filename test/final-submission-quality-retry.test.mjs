import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createAcquisitionStageProcessors} from '../src/acquisition/acquisition-stage-processors.mjs';
import {openRequestLedger} from '../src/requests/request-ledger.mjs';
import {openAcquisitionLedger} from '../src/acquisition/acquisition-ledger.mjs';
import {openHandoffLedger} from '../src/acquisition/handoff-ledger.mjs';
import {openAcquisitionRequestQueue,createAcquisitionPageWorker} from '../src/acquisition/acquisition-request-queue.mjs';
import {openQualityInspectionRetry} from '../src/acquisition/quality-inspection-retry.mjs';
import {openCandidateCheckCache} from '../src/acquisition/candidate-check-cache.mjs';
import {prepareStoppedCandidate} from '../src/acquisition/prepare-stopped-candidate.mjs';

const info=Buffer.from('d6:lengthi1000e4:name6:01.mkv12:piece lengthi16384e6:pieces20:aaaaaaaaaaaaaaaaaaaae');

async function fixture(t,{cached=true,manual=false,postReservation=false,conflict=false,older=false,kind="movie",pack=false}={}){
 const dir=await mkdtemp(path.join(tmpdir(),'negev-final-quality-')),db=path.join(dir,'state.sqlite');
 const episodeIds=pack?[1001,1002]:[1001];
 const files=episodeIds.map((id,i)=>({name:pack?`0${i+1}.mkv`:'01.mkv',size:1000,episodeIds:[id]}));
 const encode=v=>Buffer.isBuffer(v)?Buffer.concat([Buffer.from(v.length+':'),v]):typeof v==='string'?encode(Buffer.from(v)):typeof v==='number'?Buffer.from('i'+v+'e'):Array.isArray(v)?Buffer.concat([Buffer.from('l'),...v.map(encode),Buffer.from('e')]):Buffer.concat([Buffer.from('d'),...Object.keys(v).sort().flatMap(k=>[encode(k),encode(v[k])]),Buffer.from('e')]);
 const metadata=pack?{files:files.map(f=>({length:f.size,path:[f.name.split('/').at(-1)]})),name:'Example','piece length':16384,pieces:Buffer.alloc(20,1)}:null;
 const bytes=pack?encode({info:metadata}):Buffer.concat([Buffer.from('d4:info'),info,Buffer.from('e')]);
 const hash=createHash('sha1').update(pack?encode(metadata):info).digest('hex');
 const high={indexerId:3,guid:'high',title:pack?'Example Complete Batch 1080p':'Example 01 1080p',size:1000*episodeIds.length,seeders:20,evidence:'unverified'};
 const detail={state:'details',complete:true,total:episodeIds.length,anidbId:42,kind,title:'Example',restricted:false,episodes:episodeIds.map((id,i)=>({id,number:i+1,type:'Episode'}))};
 const low={...high,guid:'low',title:pack?'Example Complete Batch 720p':older?'Example 01 DVD 480p':'Example 01 720p',seeders:10};
 let clock=1000,failed=!conflict,added=false,previewHits=0;
 let requests,acquisitions,handoffs,queue,retry,cache;
 const open=()=>{requests=openRequestLedger(db);acquisitions=openAcquisitionLedger(db);handoffs=openHandoffLedger(db);queue=openAcquisitionRequestQueue(db);retry=openQualityInspectionRetry(db);cache=openCandidateCheckCache(db,{now:()=>clock})};
 const close=()=>{cache.close();retry.close();queue.close();handoffs.close();acquisitions.close();requests.close()};
 open();t.after(async()=>{close();await rm(dir,{recursive:true,force:true})});
 const id=requests.submit({requesterId:1,requestKey:'retry',nowMs:clock,intent:{state:'ready',anidbId:42,kind,title:'Example',episodeIds,monitorFuture:false}}).requestId;
 const preview={state:'preflight',requestId:id,anidbId:42,torrentHash:hash,shokoPreview:'exact',episodeIds,files};
 const proxy=c=>`http://prowlarr:9696/3/download?apikey=synthetic&link=${c.guid}&file=Example`;
 const prowlarr={baseUrl:'http://prowlarr:9696/',apiKey:'synthetic',indexerIds:[3]};
 const checked=[],submitted=[];
 const provider=async input=>{const u=new URL(input);if(u.pathname.endsWith('/search'))return Response.json([high,low].map(c=>({...c,protocol:'torrent',downloadUrl:proxy(c)})));const guid=u.searchParams.get('link');checked.push({guid,clock});if(guid==='high'&&failed&&!postReservation)return new Response(null,{status:503});const payload=conflict&&guid==='high'?Buffer.concat([Buffer.from('d4:info'),Buffer.from(info.toString().replace('6:01.mkv','12:Other 01.mkv')),Buffer.from('e')]):bytes;return new Response(payload,{headers:{'content-type':'application/x-bittorrent'}})};
 const qb=async(input,init)=>{const endpoint=new URL(input).pathname;if(endpoint.endsWith('/version'))return postReservation&&failed?new Response(null,{status:503}):new Response('v5.3.0');if(endpoint.endsWith('/add')){added=true;submitted.push(clock);return new Response('Ok.')};if(endpoint.endsWith('/info')&&!added)return Response.json([]);if(endpoint.endsWith('/files'))return Response.json(files.map((f,index)=>({index,name:f.name,size:f.size,priority:1,progress:0})));if(endpoint.endsWith('/properties'))return Response.json({save_path:`/Downloads/negev/${hash}`,download_path:''});return Response.json([{hash,category:'negev',save_path:`/Downloads/negev/${hash}`,state:'stoppedDL',progress:0,downloaded:0,amount_left:1000*episodeIds.length,auto_tmm:false,force_start:false}])};
 if(cached)cache.put({request:requests.getRequest(id),candidate:high,result:preview});
 const run=async()=>{
  const stages=createAcquisitionStageProcessors({requests:manual?{getRequest:requests.getRequest.bind(requests),getReleaseControl:()=>({mode:'manual',phase:'chosen',revision:1,selection:{candidate:high,preview}})}:requests,acquisitions,handoffs,qualityInspectionRetry:retry,now:()=>clock,
   discoverCandidates:async()=>({state:'candidates',requestId:id,anidbId:42,releaseState:pack?'completed':'airing',items:[high,low]}),
   previewCandidate:async({candidate})=>{const request=requests.getRequest(id);const hit=cache.get({request,candidate});if(hit){previewHits++;return {...hit,cacheHit:true}};const prepared=await prepareStoppedCandidate({...prowlarr,query:'Example',candidate,fetchImpl:provider});if(prepared.state!=='prepared_stopped')return prepared;return preview},
   loadDetail:async()=>detail,releaseQueries:async()=>[],readRelatedTitles:async()=>({state:'related_titles',anidbId:42,items:conflict?[{anidbId:43,title:'Other'}]:[]}),readVideoExtensions:async()=>({state:'extensions',values:['.mkv']}),
   readPublicCoverage:async()=>({verifiedTargets:0,targetCount:episodeIds.length}),readEvidence:async()=>({anidbId:42,episodeIds,observedAtMs:clock-1,importFence:{state:'settled',anidbId:42,episodeIds,beforeObservedAtMs:clock-2,afterObservedAtMs:clock-1},shoko:{state:'ok',complete:true,files:[]},plex:{state:'ok',complete:true,sourceVerified:true,libraryIds:kind==='movie'?[102,123]:[102],parts:[]}}),
   publicSections:{episode:[102],movie:[123]},prowlarr,stagingHostPath:'/srv/negev/staging',holdingRoot:'/srv/negev/holding',importRoot:'/srv/shoko/import',
   verifyStagingRoot:async()=>({state:'verified_staging_root'}),verifyShokoSource:async()=>({state:'verified_shoko_source'}),realpathImpl:async()=>'/srv/negev/staging',
   inspectMounts:async()=>({qbittorrent:[{Type:'bind',Source:'/srv/negev/staging',Destination:'/Downloads/negev',RW:true}],shoko:[{Type:'bind',Source:'/srv/library',Destination:'/pure',RW:true}],plex:[{Type:'bind',Source:'/srv/library',Destination:'/source-pure',RW:false}]}),shoko:{baseUrl:'http://shoko:8111/',apiKey:'synthetic',providerId:'11111111-2222-4333-8444-555555555555'}});
  return (await createAcquisitionPageWorker({queue,now:()=>clock,limit:1,processRequest:claim=>stages.processRequest({...claim,qbittorrent:{baseUrl:'http://qb:8080/',sessionId:'synthetic'},fetchImpl:qb,providerFetchImpl:provider})}).runOnce({priorityRequestId:id})).results[0];
 };
 return {run,checked,submitted,id,get clock(){return clock},get hits(){return previewHits},recover(){failed=false},reopen(){close();open()},next(){clock=Math.max(clock+1000,queue.getResult(id).nextDueMs)},advance(ms){clock+=ms},attempt(){return acquisitions.getAttempt(1)},cached(){return cache.get({request:requests.getRequest(id),candidate:high})}};
}
for(const cached of [true,false])test(`actual worker ${cached?'cached':'uncached'} provider failure reaches older fallback within existing retry bound after reopen`,async t=>{
 const x=await fixture(t,{cached});let result=await x.run();assert.equal(result.state,'held');assert.deepEqual(x.submitted,[]);assert.equal(x.attempt(),null);
 x.reopen();for(let i=0;i<10&&!x.submitted.length;i++){x.next();result=await x.run()}
 assert.equal(result.state,'stopped_observed',JSON.stringify(result));assert.ok(x.clock-1000<=180000,`fallback took ${x.clock-1000}ms`);
 t.diagnostic(`elapsed=${x.clock-1000}ms; cached=${cached}`);assert.equal(x.submitted.length,1);assert.equal(x.checked.at(-1).guid,'low');if(cached){assert.ok(x.hits>0);assert.equal(x.cached().state,'preflight')}
});
for(const cached of [true,false])test(`actual worker ${cached?'cached':'uncached'} recovery keeps stronger release`,async t=>{const x=await fixture(t,{cached});await x.run();x.reopen();x.recover();for(let i=0;i<5&&!x.submitted.length;i++){x.next();await x.run()}assert.equal(x.submitted.length,1);assert.equal(x.checked.at(-1).guid,'high')});
test('pinned choice never substitutes older release when final verification repeatedly fails',async t=>{const x=await fixture(t,{manual:true});for(let i=0;i<5;i++){await x.run();x.next()}assert.deepEqual(x.submitted,[]);assert.ok(x.checked.every(c=>c.guid==='high'));assert.equal(x.attempt(),null)});
test('post-reservation provider reason collision cannot release quality fallback',async t=>{const x=await fixture(t,{postReservation:true});for(let i=0;i<5;i++){await x.run();x.next()}assert.deepEqual(x.submitted,[]);assert.ok(x.attempt());assert.equal(x.submitted.length,0)});

test('genuine final related-identity conflict rejects stronger release without transient hold',async t=>{const x=await fixture(t,{conflict:true});let result=await x.run();assert.equal(result.state,'held');assert.equal(x.attempt(),null);x.next();result=await x.run();assert.equal(result.state,'stopped_observed',JSON.stringify(result));assert.equal(x.checked.at(-1).guid,'low');assert.ok(x.clock-1000<=60000)});
test('legitimate 480p older fallback remains usable after sustained final outage',async t=>{const x=await fixture(t,{older:true});for(let i=0;i<8&&!x.submitted.length;i++){await x.run();if(!x.submitted.length)x.next()}assert.equal(x.submitted.length,1);assert.ok(x.clock-1000<=180000);assert.equal(x.checked.at(-1).guid,'low')});

// Completed packs retain three existing one-second bounded cursor/phase continuations.
for(const pack of [false,true])for(const recover of [false,true])test(`actual series ${pack?'completed pack':'episode'} cached final outage ${recover?'recovers strongest':'expires within three minutes'} after reopen`,async t=>{const x=await fixture(t,{kind:'series',pack});let result=await x.run();assert.equal(result.state,'held');assert.equal(x.attempt(),null);x.reopen();if(recover)x.recover();for(let i=0;i<10&&!x.submitted.length;i++){x.next();result=await x.run()}assert.equal(result.state,'stopped_observed',JSON.stringify(result));assert.ok(x.clock-1000<=(pack?180000+3*1000:180000),`fallback took ${x.clock-1000}ms`);t.diagnostic(`elapsed=${x.clock-1000}ms; pack=${pack}; recovery=${recover}`);assert.equal(x.checked.at(-1).guid,recover?'high':'low');assert.equal(x.submitted.length,1);assert.equal(x.cached().state,'preflight')});
