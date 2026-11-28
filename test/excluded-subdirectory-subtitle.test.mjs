import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
import {planTorrentTargets} from '../src/acquisition/plan-torrent-targets.mjs';import {exclusiveSubtitleNames} from '../src/acquisition/exclusive-subtitle-names.mjs';import {evaluateCompletion} from '../src/acquisition/evaluate-completion.mjs';
import {openRequestLedger} from '../src/requests/request-ledger.mjs';import {openAcquisitionLedger} from '../src/acquisition/acquisition-ledger.mjs';import {openPureMoveLedger} from '../src/acquisition/pure-move-ledger.mjs';import {processPureCompletedAttempt} from '../src/acquisition/process-pure-completed-attempt.mjs';import {publishPureMove} from '../src/acquisition/publish-pure-move.mjs';
for(const folder of ['Subs','Subtitles','subs'])test('exclude only confidently matched '+folder+' sidecars through physical publication',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'negev-excluded-subs-')),dbPath=path.join(root,'db.sqlite'),requests=openRequestLedger(dbPath),ledger=openAcquisitionLedger(dbPath);let moves;
 try{
  const hash='a'.repeat(40),files=[{name:'Example - 01.mkv',size:100},{name:'Example - 02.mkv',size:100},{name:folder+'/Example - 01.en.ass',size:10},{name:folder+'/Example - 02.en.ass',size:10}];
  const detail={state:'details',complete:true,page:1,nextPage:null,total:2,anidbId:42,kind:'series',title:'Example',restricted:false,episodes:[{id:1001,number:1,type:'Episode'},{id:1002,number:2,type:'Episode'}]},request={id:1,status:'held',anidbId:42,kind:'series',episodeIds:[1002]};
  const plan=planTorrentTargets({request,detail,prepared:{state:'prepared_stopped',files},releaseTitle:'[Group] Example Complete 1080p',trustedTitle:'Example'});assert.equal(plan.state,'planned_targets',JSON.stringify(plan));
  const excluded=new Set([...(plan.excludedVideoNames??[]),...(plan.excludedSubtitleNames??[])]),expected={hash,category:'negev',savePath:'/Downloads/negev/'+hash};
  const complete=evaluateCompletion({torrent:{hash,category:'negev',save_path:expected.savePath,state:'stoppedUP',progress:1,amount_left:0,auto_tmm:false,force_start:false},files:files.map((file,index)=>({...file,index,priority:excluded.has(file.name)?0:1,progress:excluded.has(file.name)?0:1,...(index===0?{is_seed:true}:{})})),expected});assert.equal(complete.state,'complete');
  const requestId=requests.submit({requesterId:1,requestKey:'remaining',nowMs:1,intent:{state:'ready',anidbId:42,title:'Example',kind:'series',monitorFuture:false,episodeIds:[1002]}}).requestId,candidate={indexerId:1,guid:'pack'};
  const attemptId=ledger.reserve({requestId,candidate,episodeIds:[1002],nowMs:2}).attemptId;
  ledger.bindPreparedTorrent({attemptId,candidate,hash,nowMs:3});ledger.recordFilePlan({attemptId,hash,plannedFiles:plan.plannedFiles,nowMs:4});ledger.recordTorrentSelection({attemptId,hash,files,excludedFileNames:[...excluded],nowMs:4});ledger.beginDispatch({attemptId,nowMs:5});ledger.recordTorrent({attemptId,hash,nowMs:6});ledger.beginStart({attemptId,hash,manifestDigest:'b'.repeat(64),nowMs:7});
  moves=openPureMoveLedger(dbPath);const stagingHostPath=path.join(root,'staging'),stagingRoot=path.join(stagingHostPath,hash),holdingRoot=path.join(root,'holding'),importRoot=path.join(root,'source');
  for(const dir of [stagingRoot,holdingRoot,importRoot])await mkdir(dir,{recursive:true});for(const file of files.filter(file=>!excluded.has(file.name))){const target=path.join(stagingRoot,file.name);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,Buffer.alloc(file.size,42));}
  const prepared=await processPureCompletedAttempt({requests,acquisitions:ledger,pureMoves:moves,attemptId,nowMs:1000,stagingHostPath,qbitStagingRoot:'/Downloads/negev',holdingRoot,importRoot,qbittorrent:{baseUrl:'http://synthetic.invalid/',sessionId:'synthetic'},verifyStagingRoot:async()=>({state:'verified_staging_root'}),verifyHandoffMounts:async()=>({state:'mounted_handoff_roots'}),stop:async()=>complete});assert.equal(prepared.state,'handoff_prepared',JSON.stringify(prepared));
  assert.equal((await publishPureMove({attemptId,ledger:moves,holdingRoot,importRoot,nowMs:1001})).state,'published_observed');
  const destination=path.join(importRoot,path.basename(moves.getIntent(attemptId).manifest.holdingPath));
  await assert.rejects(readFile(path.join(destination,folder,'Example - 01.en.ass')),{code:'ENOENT'});assert.equal((await readFile(path.join(destination,folder,'Example - 02.en.ass'))).length,10);
 }finally{moves?.close();ledger.close();requests.close();await rm(root,{recursive:true,force:true});}
});
test('ambiguous and unrelated subtitle directories are retained',()=>{
 const names=['Subs/01.en.ass','Other/01.en.ass','Season2/Subs/01.en.ass'];
 assert.deepEqual(exclusiveSubtitleNames(names.map(name=>({name})),['01.mkv'],['01.mp4']),[]);
 assert.deepEqual(exclusiveSubtitleNames(names.slice(1).map(name=>({name})),['01.mkv'],['02.mkv']),[]);
});
