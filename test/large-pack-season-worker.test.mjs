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

const NOW=Date.UTC(2026,10,23);
const encode = value => Buffer.isBuffer(value) ? Buffer.concat([Buffer.from(value.length+':'),value]) :
  typeof value === 'string' ? encode(Buffer.from(value)) : typeof value === 'number' ? Buffer.from('i'+value+'e') :
  Array.isArray(value) ? Buffer.concat([Buffer.from('l'),...value.map(encode),Buffer.from('e')]) :
  Buffer.concat([Buffer.from('d'),...Object.keys(value).sort().flatMap(k=>[encode(k),encode(value[k])]),Buffer.from('e')]);
const release = (guid,title,numbers=[1],seeders=10) => ({guid,indexerId:3,title,seeders,
  names:numbers.map(n=>'Example - '+String(n).padStart(2,'0')+'.mkv')});

// Real stage/ledger/discovery/preflight/submission. Only outside services are synthetic.
async function fixture(t,{title='Example',aliases=[],items,episodes=2,requested=[1],completed=false,registered=false,prediction=true}={}) {
  const root=await mkdtemp(path.join(tmpdir(),'negev-worker-quality-season-'));
  let clock=NOW;const metadataPages=[];
  const dbPath=path.join(root,'db.sqlite');const cleanups=[];const requests=openRequestLedger(dbPath),acquisitions=openAcquisitionLedger(dbPath);
  t.after(async()=>{for(const fn of cleanups)fn();acquisitions.close();requests.close();await rm(root,{recursive:true,force:true});});
  const detail={state:'details',anidbId:42,title,kind:'series',restricted:false,complete:true,page:1,total:episodes,nextPage:null,
    airDate:'2026-01-01',endDate:completed?'2026-02-01':null,episodeCount:completed?episodes:episodes+10,
    episodes:Array.from({length:episodes},(_,i)=>({id:1001+i,number:i+1,type:'Episode',title:'Episode '+(i+1),airDate:'2026-01-01'}))};
  const saved=requests.submit({requesterId:1,requestKey:'desired',nowMs:100,intent:{state:'ready',anidbId:42,title,kind:'series',monitorFuture:!completed,episodeIds:requested.map(n=>1000+n)}});
  const records=items.map(c=>{
    const names=c.names??['Example - 01.mkv'];const size=names.length*1000;
    const info={name:names.length===1?names[0]:'Pack','piece length':16384,pieces:Buffer.alloc(Math.ceil(size/16384)*20,97),
      ...(names.length===1?{length:1000}:{files:names.map(name=>({length:1000,path:[name]}))})};
    const bytes=encode({info});const metadata=inspectTorrentMetainfo({bytes});assert.equal(metadata.state,'metainfo_checked');
    const proxy='http://prowlarr:9696/3/download?apikey=synthetic&link='+c.guid+'&file=release';
    return {...c,size,bytes,metadata,protocol:'torrent',downloadUrl:proxy};
  });
  const searchRows=records.map(({names,bytes,metadata,...c})=>c);
  const prowlarrFetch=async input=>{const url=new URL(input);if(url.pathname==='/api/v1/search')return Response.json(searchRows);
    const record=records.find(c=>c.guid===url.searchParams.get('link'));assert.ok(record,'only known synthetic descriptor');return new Response(record.bytes,{headers:{"content-type":"application/x-bittorrent"}});};
  const related={state:'related_titles',anidbId:42,items:aliases.length?[{anidbId:41,title:'Example',relation:'Prequel'}]:[]};
  const readRelatedTitles=async()=>related,releaseQueries=async()=>aliases;
  const loadPage=async({page=1}={})=>{metadataPages.push(page);const next=page*100<detail.total?page+1:null;return {...detail,page,complete:detail.total<=100,episodes:detail.episodes.slice((page-1)*100,page*100),nextPage:next}};
  const loadDetail=async({anidbId})=>collectAniDbDetail({anidbId,loadPage});
  const readRequest=id=>requests.getRequest(id);const inspected=[],previews=[];
  const discoverCandidates=createRequestCandidateDiscovery({readRequest,loadDetail,releaseQueries,pause:async()=>{},
    searchReleases:async()=>({state:'candidates',items:searchRows.map(c=>({...c,evidence:'unverified'}))})});
  const previewCandidate=async input=>{inspected.push(input.candidate.guid);const checked=await previewRequestCandidate({...input,readRequest,loadDetail,releaseQueries,readRelatedTitles,
    offlineLookup:async({filename})=>{if(!prediction)return {status:204};const id=1000+Number(/- (\d+)/.exec(filename)?.[1]);return {status:200,release:{ProviderName:'Offline Importer',IsCorrupted:false,OriginalFilename:filename,ID:'offline://42-'+id,CrossReferences:[{AnidbAnimeID:42,AnidbEpisodeID:id,PercentageStart:0,PercentageEnd:100}]}};},
    inspectCorrespondence:async({files})=>({files:files.map(f=>({...f,state:registered?'likely':'unknown'}))}),
    prepare:input=>prepareStoppedCandidate({baseUrl:'http://prowlarr:9696/',apiKey:'synthetic',indexerIds:[3],fetchImpl:prowlarrFetch,...input})});previews.push({state:checked.state,reason:checked.reason,shokoPreview:checked.shokoPreview,files:checked.files?.length});return checked;};
  const added=[],started=[];let active=null,phase='stoppedDL';
  const qbitFetch=async(input,options={})=>{
    const url=new URL(input);
    if(url.pathname.endsWith('/stop')){phase='stoppedUP';return new Response('Ok.');}
    if(url.pathname.endsWith('/start')){started.push(active.guid);return new Response('Ok.');}
    if(url.pathname.endsWith('/version'))return new Response('v5.3.0');
    if(url.pathname.endsWith('/add')){
      const blob=options.body.get('torrents');const meta=inspectTorrentMetainfo({bytes:new Uint8Array(await blob.arrayBuffer())});
      active=records.find(c=>c.metadata.hash===meta.hash);assert.ok(active);added.push(active.guid);
      assert.equal(options.body.get('stopped'),'true','normal stage must add stopped');return new Response('Ok.');
    }
    if(url.pathname.endsWith('/info'))return Response.json(active?[{hash:active.metadata.hash,category:'negev',save_path:'/Downloads/negev/'+active.metadata.hash,state:phase,progress:phase==='stoppedDL'?0:1,downloaded:phase==='stoppedDL'?0:active.size,amount_left:phase==='stoppedDL'?active.size:0,auto_tmm:false,force_start:false}]:[]);
    if(url.pathname.endsWith('/properties'))return Response.json({save_path:'/Downloads/negev/'+active.metadata.hash,download_path:''});
    if(url.pathname.endsWith('/files'))return Response.json(active.metadata.files.map((f,index)=>({...f,index,priority:1,progress:phase==='stoppedDL'?0:1,...(phase!=='stoppedDL'&&index===0?{is_seed:true}:{})})));
    throw Error('Unexpected qBittorrent endpoint '+url.pathname);
  };
  const stages=createAcquisitionStageProcessors({readVideoExtensions:async()=>({state:"extensions",values:[".mkv"]}),requests,acquisitions,handoffs:{getHandoff:()=>null},discoverCandidates,previewCandidate,loadDetail,releaseQueries,readRelatedTitles,
    readPublicCoverage:async request=>({verifiedTargets:0,targetCount:request.episodeIds.length,availableEpisodeIds:[],uncertainEpisodeIds:[]}),
    readEvidence:async({anidbId,episodeIds})=>({anidbId,episodeIds,observedAtMs:clock-1,importFence:{state:'settled',anidbId,episodeIds,beforeObservedAtMs:clock-2,afterObservedAtMs:clock-1},shoko:{state:'ok',complete:true,files:[]},plex:{state:'ok',complete:true,sourceVerified:true,libraryIds:[102],parts:[]}}),
    publicSections:{episode:[102],movie:[123]},prowlarr:{baseUrl:'http://prowlarr:9696/',apiKey:'synthetic',indexerIds:[3]},
    stagingHostPath:'/srv/negev/staging',qbitStagingRoot:'/Downloads/negev',holdingRoot:'/srv/negev/holding',importRoot:'/srv/shoko/import',
    verifyStagingRoot:async()=>({state:'verified_staging_root'}),realpathImpl:async p=>p,ensureImportRoot:async()=>({state:'import_child_ready'}),verifyShokoSource:async()=>({state:'verified_shoko_source'}),
    shoko:{baseUrl:'http://shoko:8111/',apiKey:'synthetic',providerId:'11111111-2222-4333-8444-555555555555'},now:()=>clock});
  return {added,started,inspected,previews,requests,acquisitions,records,detail,root,dbPath,qbitFetch,metadataPages,setClock:value=>{clock=value},cleanup:fn=>cleanups.push(fn),finishDownload:()=>{phase='uploading'},requestId:saved.requestId,
    runStart:attemptId=>stages.processStart({attemptId,qbittorrent:{baseUrl:"http://qb:8080/",sessionId:"syntheticSID"},fetchImpl:qbitFetch}),
    selection:createReleaseSelection({requests,discoverCandidates,previewCandidate,loadDetail,now:()=>201,
      readPublicCoverage:async()=>({availableEpisodeIds:[],uncertainEpisodeIds:[]})}),
    run:input=>stages.processRequest({requestId:saved.requestId,qbittorrent:{baseUrl:'http://qb:8080/',sessionId:'syntheticSID'},fetchImpl:qbitFetch,providerFetchImpl:prowlarrFetch,...input})};
}


for(const count of [51,104,220,500])test(`completed ${count}-video pack reaches the actual Auto worker and starts once`,async t=>{
 const numbers=Array.from({length:count},(_,i)=>i+1);
 const f=await fixture(t,{episodes:count,requested:numbers,completed:true,registered:true,items:[release('batch','[G] Example Complete 1080p Batch',numbers)]});
 const selected=await f.run();assert.equal(selected.state,'stopped_observed',JSON.stringify({selected,previews:f.previews}));
 assert.equal(f.acquisitions.getFilePlan(selected.attemptId).length,count);if(count>100)assert.ok(f.metadataPages.includes(Math.ceil(count/100)));assert.deepEqual(f.added,['batch']);
 const started=await f.runStart(selected.attemptId);assert.equal(started.state,'start_unknown',JSON.stringify(started));
 await f.runStart(selected.attemptId);assert.deepEqual(f.started,['batch']);
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
