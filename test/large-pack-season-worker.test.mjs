import {openQualityInspectionRetry} from '../src/acquisition/quality-inspection-retry.mjs';
import { collectAniDbDetail } from '../src/catalogue/collect-detail.mjs';
import {openStartQueue,createStartWorker} from '../src/acquisition/start-queue.mjs';
import {DatabaseSync} from 'node:sqlite';
import {mkdir,writeFile,readFile,rename} from 'node:fs/promises';
import {openPureMoveLedger} from '../src/acquisition/pure-move-ledger.mjs';
import {processPureCompletedAttempt} from '../src/acquisition/process-pure-completed-attempt.mjs';
import {publishPureMove} from '../src/acquisition/publish-pure-move.mjs';
import {observePureMoveImport} from '../src/acquisition/observe-pure-move-import.mjs';
import {readShokoImportActivity} from '../src/availability/shoko-import-activity.mjs';
import {evaluateExactAvailability} from '../src/availability/exact-availability.mjs';
import { createReleaseSelection } from '../src/acquisition/release-selection.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { openAcquisitionLedger } from '../src/acquisition/acquisition-ledger.mjs';
import { createAcquisitionStageProcessors } from '../src/acquisition/acquisition-stage-processors.mjs';
import { createRequestCandidateDiscovery } from '../src/acquisition/request-candidate-discovery.mjs';
import { previewRequestCandidate } from '../src/acquisition/request-candidate-preflight.mjs';
import { prepareStoppedCandidate } from '../src/acquisition/prepare-stopped-candidate.mjs';
import { inspectTorrentMetainfo } from '../src/acquisition/inspect-torrent-metainfo.mjs';
import { createHeldRequestSubmitter } from '../src/requests/submit-held-request.mjs';
import { openAcquisitionRequestQueue, createAcquisitionPageWorker } from '../src/acquisition/acquisition-request-queue.mjs';

const NOW=Date.UTC(2026,10,23);
const encode = value => Buffer.isBuffer(value) ? Buffer.concat([Buffer.from(value.length+':'),value]) :
  typeof value === 'string' ? encode(Buffer.from(value)) : typeof value === 'number' ? Buffer.from('i'+value+'e') :
  Array.isArray(value) ? Buffer.concat([Buffer.from('l'),...value.map(encode),Buffer.from('e')]) :
  Buffer.concat([Buffer.from('d'),...Object.keys(value).sort().flatMap(k=>[encode(k),encode(value[k])]),Buffer.from('e')]);
const release = (guid,title,numbers=[1],seeders=10) => ({guid,indexerId:3,title,seeders,
  names:numbers.map(n=>'Example - '+String(n).padStart(2,'0')+'.mkv')});

// Real stage/ledger/discovery/preflight/submission. Only outside services are synthetic.
async function fixture(t,{title='Example',aliases=[],items,episodes=2,requested=[1],completed=false,registered=false,prediction=true,specials=[],requestedSpecials=[],prequelEpisodes=null,prequelRead=null,prequelRelationRead=null,owned=[],wholeShow=false,ignorePriorities=false,addResponse=()=>200}={}) {
  const root=await mkdtemp(path.join(tmpdir(),'negev-worker-quality-season-'));
  let clock=NOW;const metadataPages=[];
  const dbPath=path.join(root,'db.sqlite');const cleanups=[];let requests=openRequestLedger(dbPath),acquisitions=openAcquisitionLedger(dbPath);
  const available=new Set(owned.map(n=>1000+n));
  t.after(async()=>{for(const fn of cleanups)fn();acquisitions.close();requests.close();await rm(root,{recursive:true,force:true});});
  const offlineLookup=async({filename})=>{
 if(typeof prediction==='function'){const result=await prediction(filename);if(result!==true)return result;}
 else if(!prediction)return {status:204};
 const special=/S00E(\d+)/i.exec(filename);const id=special?2000+Number(special[1]):1000+Number(/(?:- |S0[1-9]E)(\d+)/i.exec(filename)?.[1]);
 return {status:200,release:{ProviderName:'Offline Importer',IsCorrupted:false,OriginalFilename:filename,ID:'offline://42-'+id,CrossReferences:[{AnidbAnimeID:42,AnidbEpisodeID:id,PercentageStart:0,PercentageEnd:100}]}};
};
const detail={state:'details',anidbId:42,title,kind:'series',restricted:false,complete:true,page:1,total:episodes+specials.length,nextPage:null,
    airDate:'2026-01-01',endDate:completed?'2026-02-01':null,episodeCount:completed?episodes:episodes+10,
    episodes:Array.from({length:episodes},(_,i)=>({id:1001+i,number:i+1,type:'Episode',title:'Episode '+(i+1),airDate:'2026-01-01'})).concat(specials.map(number=>({id:2000+number,number,type:'Special',title:'Special '+number,airDate:'2026-01-01'})))};
  const saved=wholeShow ? await createHeldRequestSubmitter({ledger:requests,confirmKnownTitle:async()=>true,
    authorizeRequester:()=>({active:true,adultAllowed:true}),loadDetail:async()=>detail,
    recentlyAvailable:({episodeId})=>available.has(episodeId),now:()=>100,today:()=> '2026-11-23'})({requesterId:1,anidbId:42,scope:'installment',requestKey:'desired'}) :
    requests.submit({requesterId:1,requestKey:'desired',nowMs:100,intent:{state:'ready',anidbId:42,title,kind:'series',monitorFuture:!completed,episodeIds:[...requested.map(n=>1000+n),...requestedSpecials.map(n=>2000+n)]}});
  const records=items.map(c=>{
    const names=c.names??['Example - 01.mkv'];const size=names.length*1000;
    const info={name:names.length===1?names[0]:'Pack','piece length':16384,pieces:Buffer.alloc(Math.ceil(size/16384)*20,97),
      ...(names.length===1?{length:1000}:{files:names.map(name=>({length:1000,path:[name]}))})};
    const bytes=encode({info});const metadata=inspectTorrentMetainfo({bytes});assert.equal(metadata.state,'metainfo_checked');
    const proxy='http://prowlarr:9696/3/download?apikey=synthetic&link='+c.guid+'&file=release';
    return {...c,size,bytes,metadata,protocol:'torrent',downloadUrl:proxy};
  });
  const searchRows=records.map(({names,bytes,metadata,...c})=>c);
  const prowlarrFetch=async input=>{const url=new URL(input);
 if(url.hostname==='shoko'){if(url.pathname==='/api/v3/ReleaseInfo/Provider')return Response.json([{Name:'Offline Importer',IsEnabled:true,ID:'11111111-2222-4333-8444-555555555555'}]);const predicted=await offlineLookup({filename:url.searchParams.get('id')?.slice(9)});return predicted.status===200?Response.json(predicted.release):new Response(null,{status:predicted.status||503});}
 if(url.pathname==='/api/v1/search')return Response.json(searchRows);
    const record=records.find(c=>c.guid===url.searchParams.get('link'));assert.ok(record,'only known synthetic descriptor');return new Response(record.bytes,{headers:{"content-type":"application/x-bittorrent"}});};
  const related={state:'related_titles',anidbId:42,items:prequelEpisodes!==null?[{anidbId:41,title:'Example Season 1',relation:'Prequel'}]:aliases.length?[{anidbId:41,title:'Example',relation:'Prequel'}]:[]};
  const readRelatedTitles=async({anidbId})=>anidbId===41?(prequelRelationRead?prequelRelationRead({state:'related_titles',anidbId:41,items:[]}):{state:'related_titles',anidbId:41,items:[]}):related,releaseQueries=async()=>aliases;
  const loadPage=async({page=1}={})=>{metadataPages.push(page);const next=page*100<detail.total?page+1:null;return {...detail,page,complete:detail.total<=100,episodes:detail.episodes.slice((page-1)*100,page*100),nextPage:next}};
  const loadDetail=async({anidbId})=>{if(anidbId===41&&prequelEpisodes!==null){const value={...detail,anidbId:41,title:'Example Season 1',complete:true,total:prequelEpisodes,nextPage:null,episodes:Array.from({length:prequelEpisodes},(_,i)=>({id:3001+i,number:i+1,type:'Episode',title:'Previous '+(i+1)}))};return prequelRead?prequelRead(value):value;}return collectAniDbDetail({anidbId,loadPage});};
  const readRequest=id=>requests.getRequest(id);const inspected=[],previews=[];
  const discoverCandidates=createRequestCandidateDiscovery({readRequest,loadDetail,releaseQueries,pause:async()=>{},
    searchReleases:async()=>({state:'candidates',items:searchRows.map(c=>({...c,evidence:'unverified'}))})});
  const previewCandidate=async input=>{inspected.push(input.candidate.guid);const checked=await previewRequestCandidate({...input,readRequest,loadDetail,releaseQueries,readRelatedTitles,
    offlineLookup,
    inspectCorrespondence:async({files})=>({files:files.map(f=>({...f,state:registered?'likely':'unknown'}))}),
    prepare:input=>prepareStoppedCandidate({baseUrl:'http://prowlarr:9696/',apiKey:'synthetic',indexerIds:[3],fetchImpl:prowlarrFetch,...input})});previews.push({state:checked.state,reason:checked.reason,shokoPreview:checked.shokoPreview,files:checked.files?.length});return checked;};
  const added=[],started=[],startPriorities=[],priorities=new Map();let active=null,phase='stoppedDL';
  const qbitFetch=async(input,options={})=>{
    const url=new URL(input);
    if(url.pathname.endsWith('/stop')){phase='stoppedUP';return new Response('Ok.');}
    if(url.pathname.endsWith('/filePrio')){if(!ignorePriorities)for(const index of options.body.get('id').split('|'))priorities.set(Number(index),Number(options.body.get('priority')));return new Response('Ok.');}
    if(url.pathname.endsWith('/start')){started.push(active.guid);startPriorities.push(active.metadata.files.map((file,index)=>({name:file.name,priority:priorities.get(index)??1})));return new Response('Ok.');}
    if(url.pathname.endsWith('/version'))return new Response('v5.3.0');
    if(url.pathname.endsWith('/add')){
      const status=addResponse();if(status!==200)return new Response(null,{status});
      const blob=options.body.get('torrents');const meta=inspectTorrentMetainfo({bytes:new Uint8Array(await blob.arrayBuffer())});
      active=records.find(c=>c.metadata.hash===meta.hash);assert.ok(active);added.push(active.guid);
      assert.equal(options.body.get('stopped'),'true','normal stage must add stopped');return new Response('Ok.');
    }
    if(url.pathname.endsWith('/info')&&url.searchParams.get('hashes')&&active&&url.searchParams.get('hashes')!==active.metadata.hash)return Response.json([]);
    if(url.pathname.endsWith('/info'))return Response.json(active?[{hash:active.metadata.hash,category:'negev',save_path:'/Downloads/negev/'+active.metadata.hash,state:phase,progress:phase==='stoppedDL'?0:1,downloaded:phase==='stoppedDL'?0:active.size,amount_left:phase==='stoppedDL'?active.size:0,auto_tmm:false,force_start:false}]:[]);
    if(url.pathname.endsWith('/properties'))return Response.json({save_path:'/Downloads/negev/'+active.metadata.hash,download_path:''});
    if(url.pathname.endsWith('/files'))return Response.json(active.metadata.files.map((f,index)=>({...f,index,priority:priorities.get(index)??1,progress:phase==='stoppedDL'||priorities.get(index)===0?0:1,...(phase!=='stoppedDL'&&index===0?{is_seed:true}:{})})));
    throw Error('Unexpected qBittorrent endpoint '+url.pathname);
  };
  let qualityInspectionRetry=openQualityInspectionRetry(dbPath);cleanups.push(()=>qualityInspectionRetry.close());
  const createStages=()=>createAcquisitionStageProcessors({qualityInspectionRetry,providerFetchImpl:prowlarrFetch,readVideoExtensions:async()=>({state:"extensions",values:[".mkv"]}),requests,acquisitions,handoffs:{getHandoff:()=>null},discoverCandidates,previewCandidate,loadDetail,releaseQueries,readRelatedTitles,
    readPublicCoverage:async request=>({verifiedTargets:request.episodeIds.filter(id=>available.has(id)).length,targetCount:request.episodeIds.length,availableEpisodeIds:request.episodeIds.filter(id=>available.has(id)),uncertainEpisodeIds:[]}),
    readEvidence:async({anidbId,episodeIds})=>({anidbId,episodeIds,observedAtMs:clock-1,importFence:{state:'settled',anidbId,episodeIds,beforeObservedAtMs:clock-2,afterObservedAtMs:clock-1},shoko:{state:'ok',complete:true,files:[]},plex:{state:'ok',complete:true,sourceVerified:true,libraryIds:[102],parts:[]}}),
    publicSections:{episode:[102],movie:[123]},prowlarr:{baseUrl:'http://prowlarr:9696/',apiKey:'synthetic',indexerIds:[3]},
    stagingHostPath:'/srv/negev/staging',qbitStagingRoot:'/Downloads/negev',holdingRoot:'/srv/negev/holding',importRoot:'/srv/shoko/import',
    verifyStagingRoot:async()=>({state:'verified_staging_root'}),realpathImpl:async p=>p,ensureImportRoot:async()=>({state:'import_child_ready'}),verifyShokoSource:async()=>({state:'verified_shoko_source'}),
    shoko:{baseUrl:'http://shoko:8111/',apiKey:'synthetic',providerId:'11111111-2222-4333-8444-555555555555'},now:()=>clock});
  let stages=createStages();
  return {restart:()=>{qualityInspectionRetry.close();qualityInspectionRetry=openQualityInspectionRetry(dbPath);stages=createStages()},
    reopen:()=>{qualityInspectionRetry.close();acquisitions.close();requests.close();requests=openRequestLedger(dbPath);acquisitions=openAcquisitionLedger(dbPath);qualityInspectionRetry=openQualityInspectionRetry(dbPath);stages=createStages()},
    get requests(){return requests},get acquisitions(){return acquisitions},available,added,started,startPriorities,inspected,previews,records,detail,root,dbPath,qbitFetch,metadataPages,setClock:value=>{clock=value},cleanup:fn=>cleanups.push(fn),finishDownload:()=>{phase='uploading'},requestId:saved.requestId,
    runStart:attemptId=>stages.processStart({attemptId,qbittorrent:{baseUrl:"http://qb:8080/",sessionId:"syntheticSID"},fetchImpl:qbitFetch}),
    selection:createReleaseSelection({requests,discoverCandidates,previewCandidate,loadDetail,now:()=>201,
      readPublicCoverage:async()=>({availableEpisodeIds:[],uncertainEpisodeIds:[]})}),
    run:input=>stages.processRequest({requestId:saved.requestId,qbittorrent:{baseUrl:'http://qb:8080/',sessionId:'syntheticSID'},fetchImpl:qbitFetch,providerFetchImpl:prowlarrFetch,...input})};
}


for(const count of [6,51,104,220,500])test(`completed ${count}-video pack reaches the actual Auto worker and starts once`,async t=>{
 const numbers=Array.from({length:count},(_,i)=>i+1);
 const f=await fixture(t,{episodes:count,requested:numbers,completed:true,registered:true,items:[release('batch','[G] Example Complete 1080p Batch',numbers)]});
 const selected=await f.run();assert.equal(selected.state,'stopped_observed',JSON.stringify({selected,previews:f.previews}));
 assert.equal(f.acquisitions.getFilePlan(selected.attemptId).length,count);if(count>100)assert.ok(f.metadataPages.includes(Math.ceil(count/100)));assert.deepEqual(f.added,['batch']);
 const started=await f.runStart(selected.attemptId);assert.equal(started.state,'start_unknown',JSON.stringify(started));
 await f.runStart(selected.attemptId);assert.deepEqual(f.started,['batch']);
});

test('whole-season Auto uses a full pack for only missing episodes and keeps completion after reopen',async t=>{
 const numbers=[1,2,3,4,5,6],names=numbers.map(n=>`Example - 0${n}.mkv`);
 const f=await fixture(t,{episodes:6,wholeShow:true,owned:[1,2],completed:true,registered:true,
  items:[{...release('full','[G] Example Complete 1080p Batch',numbers),names:[...names,'Example - 01.en.ass','Example - 03.en.ass']}]});
 assert.deepEqual(f.requests.getRequest(f.requestId).episodeIds,[1003,1004,1005,1006]);
 const selected=await f.run();assert.equal(selected.state,'stopped_observed',JSON.stringify({selected,previews:f.previews}));
 assert.deepEqual(f.acquisitions.getFilePlan(selected.attemptId).map(file=>file.episodeIds),[[1003],[1004],[1005],[1006]]);
 f.reopen();assert.equal((await f.runStart(selected.attemptId)).state,'start_unknown');
 assert.deepEqual(f.startPriorities[0].map(file=>file.priority),[0,0,1,1,1,1,0,1]);
 const hash=f.acquisitions.getAttempt(selected.attemptId).torrentHash;
 const stagingHostPath=path.join(f.root,'stage'),stagingRoot=path.join(stagingHostPath,hash),holdingRoot=path.join(f.root,'holding'),importRoot=path.join(f.root,'import');
 const originals=path.join(f.root,'existing');await mkdir(originals);for(const n of [1,2])await writeFile(path.join(originals,n+'.mkv'),'original-'+n);
 for(const dir of [stagingRoot,holdingRoot,importRoot])await mkdir(dir,{recursive:true});
 for(const file of f.startPriorities[0].filter(file=>file.priority!==0))await writeFile(path.join(stagingRoot,file.name),Buffer.alloc(1000,42));
 const moves=openPureMoveLedger(f.dbPath);f.cleanup(()=>moves.close());f.finishDownload();
 const completed=await processPureCompletedAttempt({attemptId:selected.attemptId,requests:f.requests,acquisitions:f.acquisitions,pureMoves:moves,nowMs:NOW+1000,stagingHostPath,qbitStagingRoot:'/Downloads/negev',holdingRoot,importRoot,qbittorrent:{baseUrl:'http://qb:8080/',sessionId:'syntheticSID'},fetchImpl:f.qbitFetch,verifyStagingRoot:async()=>({state:'verified_staging_root'}),verifyHandoffMounts:async()=>({state:'mounted_handoff_roots'})});
 assert.equal(completed.state,'handoff_prepared',JSON.stringify(completed));
 assert.deepEqual(moves.getIntent(selected.attemptId).manifest.files.map(file=>file.name).sort(),[...names.slice(2),'Example - 03.en.ass'].sort());
 assert.equal((await publishPureMove({attemptId:selected.attemptId,ledger:moves,holdingRoot,importRoot,nowMs:NOW+2000})).state,'published_observed');
 const move=moves.getIntent(selected.attemptId),prefix=path.basename(move.manifest.holdingPath);
 const files=move.manifest.files.filter(file=>file.episodeIds).map((file,i)=>({fileId:2000+i,anidbId:42,size:file.size,episodeIds:file.episodeIds,coverage:file.episodeIds.map(episodeId=>({episodeId,start:0,end:100})),sourcePaths:['/pure/'+prefix+'/'+file.name],releaseEvidence:'offline_identified',storageKey:'file-'+i}));
 assert.equal((await observePureMoveImport({move,target:{anidbId:42,episodeIds:[1003,1004,1005,1006]},shokoMount:{localRoot:importRoot,appRoot:'/pure'},readEpisode:async({episodeId})=>({state:'ok',complete:true,files:files.filter(file=>file.episodeIds.includes(episodeId))})})).state,'shoko_files_identified');
 for(const id of [1003,1004,1005,1006]){assert.equal(evaluateExactAvailability({target:{anidbId:42,episodeId:id},publicLibraryIds:[102],shoko:{state:'ok',complete:true,files},plex:{state:'ok',complete:true,parts:files.map(file=>({storageKey:file.storageKey,libraryId:102,readable:true}))}}).state,'available');f.available.add(id);}
 let queue=openAcquisitionRequestQueue(f.dbPath);let visits=0;
 const run=()=>createAcquisitionPageWorker({queue,now:()=>NOW+3000,processRequest:async input=>{visits++;return f.run(input)}}).runOnce();
 await run();assert.equal(queue.getResult(f.requestId).reason,'request_fully_available');queue.close();f.reopen();queue=openAcquisitionRequestQueue(f.dbPath);await run();queue.close();assert.equal(visits,1);
 assert.deepEqual(f.added,['full']);assert.deepEqual(f.started,['full']);
 for(const n of [1,2])assert.equal(await readFile(path.join(originals,n+'.mkv'),'utf8'),'original-'+n);
});

test('whole-season pack cannot start if the downloader ignores exclusions',async t=>{
 const f=await fixture(t,{episodes:6,wholeShow:true,owned:[1,2],completed:true,registered:true,ignorePriorities:true,
  items:[release('full','[G] Example Complete 1080p Batch',[1,2,3,4,5,6])]});
 assert.equal((await f.run()).state,'held');assert.deepEqual(f.started,[]);
});

test('trusted year-suffixed textual season alias survives preflight, submission and start',async t=>{
 const f=await fixture(t,{title:'Example Season 2',aliases:['Example Second Season (2025)'],completed:true,registered:true,episodes:2,requested:[1,2],items:[{...release('alias','[G] Example Season 2 1080p Batch',[1,2]),names:['Example Second Season - 01.mkv','Example Second Season - 02.mkv']}]});
 const selected=await f.run();assert.equal(selected.state,'stopped_observed',JSON.stringify(selected));
 assert.equal((await f.runStart(selected.attemptId)).state,'start_unknown');assert.deepEqual(f.started,['alias']);
});

for(const count of [52,220,500])test(`${count}-video pack passes actual completion, journal reopen, physical publication and exact import confirmation`,async t=>{
 const numbers=Array.from({length:count},(_,i)=>i+1);
 const f=await fixture(t,{episodes:count,requested:numbers,completed:true,registered:true,items:[release('pack','[G] Example Complete 1080p Batch',numbers)]});
 const selected=await f.run();assert.equal(selected.state,'stopped_observed',JSON.stringify(selected));await f.runStart(selected.attemptId);
 const hash=f.acquisitions.getAttempt(selected.attemptId).torrentHash;
 const stagingHostPath=path.join(f.root,'stage'),stagingRoot=path.join(stagingHostPath,hash),holdingRoot=path.join(f.root,'holding'),importRoot=path.join(f.root,'import');
 for(const dir of [stagingRoot,holdingRoot,importRoot])await mkdir(dir,{recursive:true});
 for(const file of f.records[0].metadata.files){const target=path.join(stagingRoot,file.name);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,Buffer.alloc(file.size,42));}
 let moves=openPureMoveLedger(f.dbPath);f.cleanup(()=>moves.close());f.finishDownload();
 const completed=await processPureCompletedAttempt({attemptId:selected.attemptId,requests:f.requests,acquisitions:f.acquisitions,pureMoves:moves,nowMs:NOW+1000,stagingHostPath,qbitStagingRoot:'/Downloads/negev',holdingRoot,importRoot,qbittorrent:{baseUrl:'http://qb:8080/',sessionId:'syntheticSID'},fetchImpl:f.qbitFetch,verifyStagingRoot:async()=>({state:'verified_staging_root'}),verifyHandoffMounts:async()=>({state:'mounted_handoff_roots'})});
 assert.equal(completed.state,'handoff_prepared',JSON.stringify(completed));
 moves.close();moves=openPureMoveLedger(f.dbPath);
 const published=await publishPureMove({attemptId:selected.attemptId,ledger:moves,holdingRoot,importRoot,nowMs:NOW+2000,...(count>52?{renamePrepared:async(source,dest)=>{await rename(source,dest);throw Error('synthetic lost journal receipt')}}:{})});assert.equal(published.state,count>52?'held':'published_observed',JSON.stringify(published));
 const move=moves.getIntent(selected.attemptId),prefix=path.basename(move.manifest.holdingPath);
 const shokoFiles=move.manifest.files.map((file,i)=>({fileId:2000+i,anidbId:42,size:file.size,episodeIds:file.episodeIds,coverage:file.episodeIds.map(episodeId=>({episodeId,start:0,end:100})),sourcePaths:['/pure/'+prefix+'/'+file.name],releaseEvidence:'offline_identified',storageKey:'file-'+i}));
 const imported=await observePureMoveImport({move,target:{anidbId:42,episodeIds:f.requests.getRequest(f.requestId).episodeIds},shokoMount:{localRoot:importRoot,appRoot:'/pure'},readEpisode:async({episodeId})=>({state:'ok',complete:true,files:shokoFiles.filter(file=>file.episodeIds.includes(episodeId))})});
 assert.equal(imported.state,'shoko_files_identified',JSON.stringify(imported));assert.equal(imported.files.length,count);
 if(count>52)assert.equal(moves.recordContentPresent({attemptId:selected.attemptId,files:imported.files,nowMs:NOW+3000}).state,'content_present');
 const parts=shokoFiles.map(file=>({storageKey:file.storageKey,libraryId:102,readable:true}));
 for(const episodeId of f.requests.getRequest(f.requestId).episodeIds)assert.equal(evaluateExactAvailability({target:{anidbId:42,episodeId},publicLibraryIds:[102],shoko:{state:'ok',complete:true,files:shokoFiles},plex:{state:'ok',complete:true,parts}}).state,'available');
 for(const file of move.manifest.files)assert.equal((await readFile(path.join(importRoot,prefix,file.name))).length,file.size);
 await f.run();assert.deepEqual(f.added,['pack']);assert.deepEqual(f.started,['pack']);
});

test('Manual Pick retains an exact 104-video unknown-registration choice through ledger reopen',async t=>{
 const numbers=Array.from({length:104},(_,i)=>i+1),f=await fixture(t,{episodes:104,requested:numbers,completed:true,registered:false,items:[release('manual','[G] Example Complete 1080p Batch',numbers)]});
 const begun=f.selection.begin(f.requestId,'manual',f.selection.snapshot(f.requestId).revision),found=await f.selection.search(f.requestId);
 assert.equal(found.items.length,1);const token=found.items[0].token;
 assert.equal((await f.selection.inspect(f.requestId,token)).files.length,104);
 const choice=await f.selection.choose(f.requestId,token,begun.control.revision);assert.equal(choice.state,'updated',JSON.stringify(choice));
 const reopened=openRequestLedger(f.dbPath);try{assert.equal(reopened.getReleaseControl(f.requestId,NOW).selection.preview.files.length,104)}finally{reopened.close()}
 const result=await f.run();assert.equal(result.state,'stopped_observed',JSON.stringify(result));assert.deepEqual(f.added,['manual']);
});


test('legacy year-alias start hold re-evaluates once through the actual worker without request recreation',async t=>{
 const f=await fixture(t,{title:'Example Season 2',aliases:['Example Second Season (2025)'],completed:true,registered:true,episodes:2,requested:[1,2],items:[{...release('alias','[G] Example Season 2 1080p Batch',[1,2]),names:['Example Second Season - 01.mkv','Example Second Season - 02.mkv']}]});
 const selected=await f.run();assert.equal(selected.state,'stopped_observed');
 let q=openStartQueue(f.dbPath);f.cleanup(()=>q.close());const claim=q.claimNext({nowMs:NOW});
 q.recordResult({attemptId:claim.attemptId,version:claim.version,state:'held',reason:'related_installment_mismatch',checkedMs:NOW});q.close();
 const db=new DatabaseSync(f.dbPath);db.prepare('UPDATE start_checks SET title_policy_revision=1 WHERE attempt_id=?').run(selected.attemptId);db.close();
 q=openStartQueue(f.dbPath);assert.equal(q.getResult(selected.attemptId).nextDueMs,NOW+60000);assert.equal(f.acquisitions.getStart(selected.attemptId),null);
 f.setClock(NOW+60000);const worker=createStartWorker({queue:q,now:()=>NOW+60000,processAttempt:({attemptId})=>f.runStart(attemptId)});
 assert.equal((await worker.runOnce()).result.state,'start_unknown');assert.deepEqual(f.started,['alias']);
 q.close();q=openStartQueue(f.dbPath);assert.equal((await createStartWorker({queue:q,now:()=>NOW+120000,processAttempt:({attemptId})=>f.runStart(attemptId)}).runOnce()).state,'idle');assert.deepEqual(f.started,['alias']);
});

for(const mixed of [false,true])test(`explicit Special ${mixed?'alongside regular 01':'alone'} reaches actual discovery, stopped submission and start`,async t=>{
 const f=await fixture(t,{episodes:1,specials:[1],requested:mixed?[1]:[],requestedSpecials:[1],items:[
  {...release('special','[G] Example Special 01 1080p',[1]),names:['Example S00E01.mkv']},
  {...release('regular','[G] Example - 01 1080p',[1]),names:['Example - 01.mkv']}]});
 const selected=await f.run();assert.equal(selected.state,'stopped_observed',JSON.stringify(selected));
 const files=f.acquisitions.getFilePlan(selected.attemptId);const expected=f.added[0]==='special'?2001:1001;
 assert.deepEqual(files.map(x=>x.episodeIds),[[expected]]);if(!mixed)assert.equal(expected,2001);
 assert.equal((await f.runStart(selected.attemptId)).state,'start_unknown');assert.deepEqual(f.started,[f.added[0]]);
 if(mixed){const next=await f.run();assert.equal(next.state,'stopped_observed',JSON.stringify(next));assert.notEqual(next.attemptId,selected.attemptId);assert.deepEqual(new Set(f.acquisitions.getFilePlan(next.attemptId).flatMap(x=>x.episodeIds).concat(expected)),new Set([1001,2001]));assert.equal((await f.runStart(next.attemptId)).state,'start_unknown');assert.equal(new Set(f.started).size,2);}
});
for(const recovered of [true,false])test(`temporary alias Shoko failure ${recovered?'recovers high quality':'permits fallback only after budget'}`,async t=>{
 let ready=false;
 const f=await fixture(t,{title:'Himitsu no Mise (2025)',aliases:['Secret Shop (2025)'],completed:true,registered:true,episodes:2,requested:[1,2],prediction:filename=>ready||!filename.startsWith('Secret Shop')?true:{status:503},items:[
  {...release('strong','[G] Secret Shop Season 02 [2025] Complete 1080p',[1,2],30),names:['Secret Shop S02E01.mkv','Secret Shop S02E02.mkv']},
  {...release('weak','[G] Himitsu no Mise (2025) 720p Batch',[1,2],30),names:['Himitsu no Mise - 01.mkv','Himitsu no Mise - 02.mkv']}]});
 const held=await f.run();assert.equal(held.state,'held',JSON.stringify(held));assert.deepEqual(f.added,[],'temporary provider failure must not downgrade immediately');
 f.restart();ready=recovered;f.setClock(NOW+(recovered?61000:181000));const selected=await f.run();assert.equal(selected.state,'stopped_observed',JSON.stringify(selected));
 assert.deepEqual(f.added,[recovered?'strong':'weak']);assert.equal((await f.runStart(selected.attemptId)).state,'start_unknown');
});

test('alias provider failure only at final submission never dispatches and recovers through the worker',async t=>{
 let calls=0,recovered=false;
 const f=await fixture(t,{title:'Himitsu no Mise (2025)',aliases:['Secret Shop (2025)'],completed:true,registered:true,episodes:2,requested:[1,2],prediction:()=>++calls<=2||recovered?true:{status:503},items:[
 {...release('strong','[G] Secret Shop Season 02 [2025] Complete 1080p',[1,2],30),names:['Secret Shop S02E01.mkv','Secret Shop S02E02.mkv']}]});
 const first=await f.run();assert.equal(first.state,'held',JSON.stringify(first));assert.equal(first.reason,'release_preflight_unavailable');assert.deepEqual(f.added,[]);assert.equal(f.acquisitions.getAttempt(1),null);
 f.restart();recovered=true;f.setClock(NOW+61000);const result=await f.run();assert.equal(result.state,'stopped_observed',JSON.stringify(result));assert.deepEqual(f.added,['strong']);assert.equal((await f.runStart(result.attemptId)).state,'start_unknown');
});

test('broad Special dash hit survives overlapping regular search and leaves regular pending',async t=>{
 const f=await fixture(t,{episodes:1,specials:[1],requested:[1],requestedSpecials:[1],items:[{...release('special','[G] Example Special - 01 1080p'),names:['Example S00E01.mkv']}]});
 const selected=await f.run();assert.equal(selected.state,'stopped_observed',JSON.stringify({selected,previews:f.previews}));
 assert.deepEqual(f.acquisitions.getFilePlan(selected.attemptId).flatMap(x=>x.episodeIds),[2001]);
 assert.equal((await f.runStart(selected.attemptId)).state,'start_unknown');
 f.restart();await f.run();assert.deepEqual(f.added,['special']);assert.deepEqual(f.started,['special']);
 assert.deepEqual(f.requests.getRequest(f.requestId).episodeIds,[1001,2001]);
});
for(const mode of ['recover','expire','known'])test('absolute-offset outage '+mode+' through actual stage and restart',async t=>{
 let ready=false;const f=await fixture(t,{title:'Example Season 2',completed:true,registered:true,episodes:2,requested:[1,2],prequelEpisodes:mode==='known'?24:null,
 prediction:filename=>{if(!/ - (25|26)/.test(filename))return true;if(!ready)return{status:503};const id=filename.includes('25')?1001:1002;return{status:200,release:{ProviderName:'Offline Importer',IsCorrupted:false,OriginalFilename:filename,ID:'offline://42-'+id,CrossReferences:[{AnidbAnimeID:42,AnidbEpisodeID:id,PercentageStart:0,PercentageEnd:100}]}}},
 items:[{...release('strong','[G] Example Season 2 1080p Batch',[25,26],30)},release('weak','[G] Example Season 2 720p Batch',[1,2],30)]});
 const first=await f.run();if(mode==='known'){assert.equal(first.state,'stopped_observed',JSON.stringify(first));assert.deepEqual(f.added,['strong']);return;}
 assert.equal(first.state,'held',JSON.stringify({first,previews:f.previews}));assert.deepEqual(f.added,[]);
 f.restart();ready=mode==='recover';f.setClock(NOW+(ready?61000:181000));const selected=await f.run();assert.equal(selected.state,'stopped_observed',JSON.stringify({selected,previews:f.previews}));
 assert.deepEqual(f.added,[ready?'strong':'weak']);assert.equal((await f.runStart(selected.attemptId)).state,'start_unknown');
});

for(const failure of ['pending','unavailable','throw','relations'])for(const recovers of [true,false])test('temporary prequel '+failure+' '+(recovers?'recovers1080p':'expires to normal fallback')+' across actual stage restart',async t=>{
 let ready=false;const fail=value=>{if(ready)return value;if(failure==='throw')throw Error('synthetic unavailable');return{state:failure==='pending'?'detail_pending':'unavailable',anidbId:41};};
 const f=await fixture(t,{title:'Example Season 2',episodes:2,requested:[1,2],completed:true,registered:true,prequelEpisodes:24,prediction:false,
  ...(failure==='relations'?{prequelRelationRead:fail}:{prequelRead:fail}),
  items:[release('strong','[G] Example Season 2 1080p Batch',[25,26],30),release('weak','[G] Example Season 2 720p Batch',[1,2],30)]});
 const first=await f.run();assert.equal(first.state,'held',JSON.stringify({first,previews:f.previews}));assert.deepEqual(f.added,[]);
 f.restart();ready=recovers;f.setClock(NOW+(recovers?61000:181000));const next=await f.run();assert.equal(next.state,'stopped_observed',JSON.stringify({next,previews:f.previews}));assert.deepEqual(f.added,[recovers?'strong':'weak']);assert.equal((await f.runStart(next.attemptId)).state,'start_unknown');
});
for(const recovers of [true,false])test('partial absolute filename503 '+(recovers?'recovers1080p':'allows expired fallback')+' through actual stage restart',async t=>{
 let ready=false;const f=await fixture(t,{title:'Example Season 2',episodes:4,requested:[1,2,3,4],completed:true,registered:true,prequelEpisodes:24,
  prediction:filename=>{const n=Number(/ - (\d+)/.exec(filename)?.[1]);if(n<25)return true;if(!ready&&n===28)return{status:503};if(n<27)return{status:204};const id=1000+n-26;return{status:200,release:{ProviderName:'Offline Importer',IsCorrupted:false,OriginalFilename:filename,ID:'offline://42-'+id,CrossReferences:[{AnidbAnimeID:42,AnidbEpisodeID:id,PercentageStart:0,PercentageEnd:100}]}}},
  items:[release('strong','[G] Example Season 2 1080p Batch',[25,26,27,28],30),release('weak','[G] Example Season 2 720p Batch',[1,2,3,4],30)]});
 const first=await f.run();assert.equal(first.state,'held',JSON.stringify({first,previews:f.previews}));assert.deepEqual(f.added,[]);assert.ok(f.previews.some(x=>x.reason==='provider_unavailable'));assert.equal(f.previews.some(x=>x.reason==='shoko_preview_wrong_identity'),false);
 f.restart();ready=recovers;f.setClock(NOW+(recovers?61000:181000));const next=await f.run();assert.equal(next.state,'stopped_observed',JSON.stringify({next,previews:f.previews}));assert.deepEqual(f.added,[recovers?'strong':'weak']);assert.equal((await f.runStart(next.attemptId)).state,'start_unknown');
});
test('prequel provider failure appearing only at final submission retries without dispatch',async t=>{
 let reads=0,ready=false;const f=await fixture(t,{title:'Example Season 2',episodes:2,requested:[1,2],completed:true,registered:true,prequelEpisodes:24,prediction:false,prequelRead:value=>++reads===1||ready?value:{state:'detail_pending',anidbId:41},items:[release('strong','[G] Example Season 2 1080p Batch',[25,26],30)]});
 const first=await f.run();assert.equal(first.state,'held');assert.equal(first.reason,'release_preflight_unavailable');assert.deepEqual(f.added,[]);
 f.restart();ready=true;f.setClock(NOW+61000);const next=await f.run();assert.equal(next.state,'stopped_observed',JSON.stringify(next));assert.deepEqual(f.added,['strong']);
});

test('exact filename evidence proceeds despite temporarily missing prequel metadata',async t=>{
 const f=await fixture(t,{title:'Example Season 2',episodes:2,requested:[1,2],completed:true,registered:true,prequelEpisodes:24,prequelRead:()=>({state:'detail_pending',anidbId:41}),
  prediction:filename=>{const id=filename.includes('25')?1001:1002;return{status:200,release:{ProviderName:'Offline Importer',IsCorrupted:false,OriginalFilename:filename,ID:'offline://42-'+id,CrossReferences:[{AnidbAnimeID:42,AnidbEpisodeID:id,PercentageStart:0,PercentageEnd:100}]}}},items:[release('strong','[G] Example Season 2 1080p Batch',[25,26],30)]});
 const result=await f.run();assert.equal(result.state,'stopped_observed',JSON.stringify(result));assert.deepEqual(f.added,['strong']);assert.equal((await f.runStart(result.attemptId)).state,'start_unknown');
});
test('sufficient consistent offsets proceed during an unrelated partial filename outage',async t=>{
 const f=await fixture(t,{title:'Example Season 2',episodes:5,requested:[1,2,3,4,5],completed:true,registered:true,prequelEpisodes:24,
  prediction:filename=>{const n=Number(/ - (\d+)/.exec(filename)[1]);if(n===29)return{status:503};if(n<27)return{status:204};const id=1000+n-26;return{status:200,release:{ProviderName:'Offline Importer',IsCorrupted:false,OriginalFilename:filename,ID:'offline://42-'+id,CrossReferences:[{AnidbAnimeID:42,AnidbEpisodeID:id,PercentageStart:0,PercentageEnd:100}]}}},items:[release('strong','[G] Example Season 2 1080p Batch',[25,26,27,28,29],30)]});
 const result=await f.run();assert.equal(result.state,'stopped_observed',JSON.stringify({result,previews:f.previews}));assert.deepEqual(f.added,['strong']);
});

for(const recover of [true,false]) test('explicit Auto listing outage delegates bounded worker '+(recover?'1080p recovery':'720p fallback')+' across reopen',async t=>{
 let ready=false;
 const f=await fixture(t,{title:'Himitsu no Mise (2025)',aliases:['Secret Shop (2025)'],completed:true,registered:true,episodes:2,requested:[1,2],prediction:filename=>ready||!filename.startsWith('Secret Shop')?true:{status:503},items:[
  {...release('strong','[G] Secret Shop Season 02 [2025] Complete 1080p',[1,2],30),names:['Secret Shop S02E01.mkv','Secret Shop S02E02.mkv']},
  {...release('weak','[G] Himitsu no Mise (2025) 720p Batch',[1,2],30),names:['Himitsu no Mise - 01.mkv','Himitsu no Mise - 02.mkv']}]});
 assert.equal(f.selection.begin(f.requestId,'auto',f.selection.snapshot(f.requestId).revision).state,'updated');
 const found=await f.selection.search(f.requestId),strong=found.items.find(c=>c.guid==='strong');
 const inspected=await f.selection.inspect(f.requestId,strong.token);
 assert.equal(inspected.state,'inspection');assert.equal(inspected.reason,'provider_unavailable');assert.equal(inspected.files.length,2);
 assert.equal((await f.selection.auto(f.requestId,f.selection.snapshot(f.requestId).revision)).state,'updated');
 assert.equal(f.selection.snapshot(f.requestId).phase,'consumed','temporary stronger listing failure must not pin weak release');
 let clock=NOW,queue=openAcquisitionRequestQueue(f.dbPath);f.cleanup(()=>queue.close());
 const run=()=>createAcquisitionPageWorker({queue,now:()=>clock,limit:1,processRequest:input=>f.run(input)}).runOnce({priorityRequestId:f.requestId});
 let result=(await run()).results[0];assert.equal(result.state,'held');assert.deepEqual(f.added,[]);
 queue.close();f.reopen();queue=openAcquisitionRequestQueue(f.dbPath);ready=recover;
 for(let tick=0;tick<12&&!f.added.length;tick++){
  clock=Math.max(clock+1000,queue.getResult(f.requestId).nextDueMs);f.setClock(clock);result=(await run()).results[0];
 }
 assert.equal(result.state,'stopped_observed',JSON.stringify(result));assert.deepEqual(f.added,[recover?'strong':'weak']);
 assert.ok(clock-NOW<=183000,'normal bounded worker preference must expire');
 assert.equal((await f.runStart(result.attemptId)).state,'start_unknown');assert.deepEqual(f.started,[recover?'strong':'weak']);
});

test('explicit Auto deterministic listed rejection still selects valid lower quality immediately',async t=>{
 const f=await fixture(t,{episodes:2,requested:[1],registered:true,items:[
  {...release('wrong','[G] Example - 01 1080p'),names:['Example - 02.mkv']},
  release('valid','[G] Example - 01 720p') ]});
 assert.equal(f.selection.begin(f.requestId,'auto',f.selection.snapshot(f.requestId).revision).state,'updated');
 const found=await f.selection.search(f.requestId),wrong=found.items.find(c=>c.guid==='wrong');
 const inspected=await f.selection.inspect(f.requestId,wrong.token);assert.equal(inspected.state,'inspection');assert.equal(inspected.reason,'no_requested_video');
 const result=await f.selection.auto(f.requestId,f.selection.snapshot(f.requestId).revision);assert.equal(result.state,'updated');
 assert.equal(f.selection.snapshot(f.requestId).phase,'chosen');assert.equal(f.selection.snapshot(f.requestId).selection.candidate.guid,'valid');
});

test('normal request worker retries refused stopped add after reopen and starts exact candidate once',async t=>{
 let refused=true;
 const f=await fixture(t,{episodes:2,requested:[1,2],registered:true,addResponse:()=>refused?403:200,items:[release('exact','[G] Example - 01 1080p'),release('next','[G] Example - 02 1080p',[2],5)]});
 let clock=NOW,queue=openAcquisitionRequestQueue(f.dbPath);f.cleanup(()=>queue.close());
 const run=()=>createAcquisitionPageWorker({queue,now:()=>clock,limit:1,processRequest:input=>f.run(input)}).runOnce({priorityRequestId:f.requestId});
 const first=(await run()).results[0];assert.equal(first.state,'held');assert.deepEqual(f.added,[]);assert.deepEqual(f.started,[]);
 assert.equal(f.acquisitions.getAttempt(1).status,'dispatch_rejected');assert.equal(queue.getResult(f.requestId).nextDueMs,NOW+60000);
 queue.close();f.reopen();queue=openAcquisitionRequestQueue(f.dbPath);refused=false;clock=NOW+60000;f.setClock(clock);
 const second=(await run()).results[0];assert.equal(second.state,'stopped_observed',JSON.stringify(second));assert.deepEqual(f.added,['exact']);
 assert.notEqual(second.attemptId,1);assert.equal(f.acquisitions.getAttempt(second.attemptId).torrentHash,f.records[0].metadata.hash);
 assert.equal((await f.runStart(second.attemptId)).state,'start_unknown');await f.runStart(second.attemptId);assert.deepEqual(f.started,['exact']);
 f.available.add(1001);clock=queue.getResult(f.requestId).nextDueMs;f.setClock(clock);
 const next=(await run()).results[0];assert.equal(next.state,'stopped_observed',JSON.stringify(next));assert.deepEqual(f.added,['exact','next']);
 assert.deepEqual(f.acquisitions.getFilePlan(next.attemptId).flatMap(file=>file.episodeIds),[1002]);
 assert.equal((await f.runStart(next.attemptId)).state,'start_unknown');assert.deepEqual(f.started,['exact','next']);
});
