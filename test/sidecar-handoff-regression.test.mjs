import { readShokoImportActivity } from '../src/availability/shoko-import-activity.mjs';
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';import {openRequestLedger} from '../src/requests/request-ledger.mjs';import {openAcquisitionLedger} from '../src/acquisition/acquisition-ledger.mjs';import {openPureMoveLedger} from '../src/acquisition/pure-move-ledger.mjs';import {publishPureMove} from '../src/acquisition/publish-pure-move.mjs';
import assert from 'node:assert/strict';import test from 'node:test';import {previewRequestCandidate} from '../src/acquisition/request-candidate-preflight.mjs';import {evaluateStoppedManifest} from '../src/acquisition/evaluate-stopped-manifest.mjs';import {evaluateCompletion} from '../src/acquisition/evaluate-completion.mjs';import {processPureCompletedAttempt} from '../src/acquisition/process-pure-completed-attempt.mjs';
for(const subtitleCount of [52,104,474])test(`26 episode pack with ${subtitleCount} subtitle sidecars passes preflight through real publication`,async()=>{
 const episodes=Array.from({length:26},(_,i)=>({id:1001+i,number:i+1,type:'Episode',title:'Episode '+(i+1)})),ids=episodes.map(e=>e.id),hash='a'.repeat(40),request={id:1,status:'held',anidbId:42,kind:'series',episodeIds:ids},detail={state:'details',complete:true,page:1,nextPage:null,total:26,anidbId:42,kind:'series',title:'Example',restricted:false,episodes};const videos=episodes.map(e=>({name:'Example - '+String(e.number).padStart(2,'0')+'.mkv',size:1000})),subs=Array.from({length:subtitleCount},(_,i)=>({name:`Subs/${i}/Example - ${String(i%26+1).padStart(2,'0')}.English.ass`,size:10})),files=[...videos,...subs],prepared={state:'prepared_stopped',expected:{hash},version:'v1',totalBytes:26520,files,form:new FormData()};const preflight=await previewRequestCandidate({requestId:1,candidate:{guid:'pack',indexerId:1,title:'[Group] Example Complete 1080p',size:26520},readRequest:()=>request,loadDetail:async()=>detail,prepare:async()=>prepared});assert.equal(preflight.state,'preflight',JSON.stringify(preflight));
 const expected={hash,category:'negev',savePath:'/Downloads/negev/'+hash},torrent={hash,category:'negev',save_path:expected.savePath,state:'stoppedDL',progress:0,downloaded:0,amount_left:26520,auto_tmm:false,force_start:false},manifest=files.map((f,index)=>({...f,index,priority:1,progress:0}));const stopped=evaluateStoppedManifest({torrent,files:manifest,expected});assert.equal(stopped.state,'manifest_safe',JSON.stringify(stopped));const complete=evaluateCompletion({torrent:{...torrent,state:'stoppedUP',progress:1,amount_left:0},files:manifest.map((f,index)=>({...f,progress:1,...(index===0?{is_seed:true}:{})})),expected});assert.equal(complete.state,'complete');

 const root=await mkdtemp(path.join(tmpdir(),'negev-sidecars-')),db=path.join(root,'state.sqlite'),requests=openRequestLedger(db),a=openAcquisitionLedger(db);let moves;
 try{
 const rid=requests.submit({requesterId:1,requestKey:'desired',nowMs:1,intent:{state:'ready',title:'Example',anidbId:42,kind:'series',monitorFuture:false,episodeIds:ids}}).requestId;
 const candidate={indexerId:1,guid:'pack'},aid=a.reserve({requestId:rid,candidate,episodeIds:ids,nowMs:2}).attemptId;
 a.bindPreparedTorrent({attemptId:aid,candidate,hash,nowMs:3});a.recordFilePlan({attemptId:aid,hash,plannedFiles:preflight.files,nowMs:4});a.beginDispatch({attemptId:aid,nowMs:5});a.recordTorrent({attemptId:aid,hash,nowMs:6});a.beginStart({attemptId:aid,hash,manifestDigest:'b'.repeat(64),nowMs:7});
 moves=openPureMoveLedger(db);const stagingHostPath=path.join(root,'staging'),stagingRoot=path.join(stagingHostPath,hash),holdingRoot=path.join(root,'holding'),importRoot=path.join(root,'import');
 for(const dir of [stagingRoot,holdingRoot,importRoot])await mkdir(dir,{recursive:true});
 for(const f of files){const target=path.join(stagingRoot,f.name);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,Buffer.alloc(f.size,42));}
 const result=await processPureCompletedAttempt({requests,acquisitions:a,pureMoves:moves,attemptId:aid,nowMs:1000,stagingHostPath,qbitStagingRoot:'/Downloads/negev',holdingRoot,importRoot,qbittorrent:{baseUrl:'http://synthetic.invalid/',sessionId:'synthetic'},verifyStagingRoot:async()=>({state:'verified_staging_root'}),verifyHandoffMounts:async()=>({state:'mounted_handoff_roots'}),stop:async()=>complete});
 assert.equal(result.state,'handoff_prepared',JSON.stringify(result));
 assert.equal(moves.getIntent(aid).manifest.files.length,files.length);
 const published=await publishPureMove({attemptId:aid,ledger:moves,holdingRoot,importRoot,nowMs:1001});assert.equal(published.state,'published_observed',JSON.stringify(published));
 const destination=path.join(importRoot,path.basename(moves.getIntent(aid).manifest.holdingPath));
 for(const f of files)assert.equal((await readFile(path.join(destination,f.name))).length,f.size);
 const prefix=path.basename(moves.getIntent(aid).manifest.holdingPath);
 const activityInput={baseUrl:'http://shoko.invalid/',apiKey:'test',importRoot,managedFolderId:1,withFingerprint:true,target:{anidbId:43,episodeIds:[9001]},getHandoff:()=>null,getPureMove:id=>{const row=moves.getIntent(id);return row?{...row,manifest:{...row.manifest,holdingPath:row.manifest.holdingPath.split(path.sep).join('/')}}:null},fetchImpl:async url=>{
  if(new URL(url).pathname==='/api/v3/Queue')return Response.json({WaitingCount:0,BlockedCount:0,ScheduledCount:0,TotalCount:0,CurrentlyExecuting:[],Pools:[]});
  return Response.json({Total:26,List:videos.map((v,i)=>({ID:i+1,Size:v.size,SeriesIDs:[],Hashes:[{Type:'ED2K',Value:'a'.repeat(32)}],Locations:[{ManagedFolderID:1,RelativePath:prefix+'/'+v.name,IsAccessible:true}]}))});
 }};
 const activity=await readShokoImportActivity(activityInput);assert.equal(activity.state,'quiet_observed',JSON.stringify(activity));assert.equal(activity.unrelatedPendingKeys.length,26);
 // Exact same pending files remain protected for their own target.
 const own=await readShokoImportActivity({...activityInput,target:{anidbId:42,episodeIds:[1001]}});assert.equal(own.state,'busy');assert.equal(own.reason,'target_pending_import');
 console.log(JSON.stringify({videos:26,sidecars:subtitleCount,files:files.length,preflight:preflight.state,published:published.state}));
 }finally{moves?.close();a.close();requests.close();await rm(root,{recursive:true,force:true});}
});


test('501 selected files remain rejected before starting and at completion',()=>{
 const hash='a'.repeat(40),expected={hash,category:'negev',savePath:'/Downloads/negev/'+hash};
 const torrent={hash,category:'negev',save_path:expected.savePath,state:'stoppedDL',progress:0,downloaded:0,amount_left:501,auto_tmm:false,force_start:false};
 const files=Array.from({length:501},(_,index)=>({index,name:index===0?'Example - 01.mkv':`Example - 01.${index}.ass`,size:1,priority:1,progress:0}));
 assert.equal(evaluateStoppedManifest({torrent,files,expected}).reason,'invalid_file_manifest');
 assert.equal(evaluateCompletion({torrent:{...torrent,state:'stoppedUP',progress:1,amount_left:0},files:files.map(f=>({...f,progress:1,is_seed:true})),expected}).reason,'invalid_file_manifest');
});
