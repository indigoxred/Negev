import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openRequestLedger} from '../src/requests/request-ledger.mjs';
import {openAcquisitionLedger} from '../src/acquisition/acquisition-ledger.mjs';
import {openPureMoveLedger} from '../src/acquisition/pure-move-ledger.mjs';
import {processBonusImport} from '../src/acquisition/process-bonus-import.mjs';
test('a later explicit OVA request can reserve after an old optional claim expires, without releasing the main claim',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'negev-bonus-expiry-')),dbPath=path.join(root,'state.sqlite');let requests,acquisitions,moves;
 try{
  requests=openRequestLedger(dbPath);const main=requests.submit({requesterId:1,requestKey:'main',nowMs:100,intent:{state:'ready',anidbId:42,kind:'series',episodeIds:[1001],monitorFuture:false}}).requestId;
  const explicit=requests.submit({requesterId:2,requestKey:'ova',nowMs:101,intent:{state:'ready',anidbId:43,kind:'series',episodeIds:[2001],monitorFuture:false}}).requestId;
  acquisitions=openAcquisitionLedger(dbPath);const candidate={indexerId:7,guid:'pack'},hash='a'.repeat(40);
  const {attemptId}=acquisitions.reserve({requestId:main,candidate,episodeIds:[1001],nowMs:200});
  acquisitions.bindPreparedTorrent({attemptId,candidate,hash,nowMs:201});acquisitions.recordFilePlan({attemptId,hash,plannedFiles:[{name:'main.mkv',size:100,episodeIds:[1001]}],nowMs:202});
  const bonus={name:'OVA.mkv',size:20,anidbId:43,episodeIds:[2001],kind:'ova',evidence:'shoko_filename_prediction'};
  acquisitions.recordBonusPlan({attemptId,hash,files:[bonus],nowMs:202});acquisitions.beginDispatch({attemptId,nowMs:203});acquisitions.recordTorrent({attemptId,hash,nowMs:204});acquisitions.beginStart({attemptId,hash,manifestDigest:'c'.repeat(64),nowMs:205});
  moves=openPureMoveLedger(dbPath);const files=[{name:'main.mkv',size:100,episodeIds:[1001],dev:'1',ino:'2',mtimeNs:'3'},{...bonus,scope:'bonus',dev:'1',ino:'4',mtimeNs:'5'}];
  assert.equal(moves.recordIntent({attemptId,torrentHash:hash,stagingRoot:path.join(root,'staging',hash),holdingPath:path.join(root,'holding',`negev-${attemptId}-${hash.slice(0,16)}`),files,nowMs:206}).state,'recorded');
  moves.markPrepared({attemptId,nowMs:207});moves.beginPublish({attemptId,nowMs:208});moves.markPublished({attemptId,nowMs:209});
  const reserve=()=>acquisitions.reserve({requestId:explicit,candidate:{indexerId:7,guid:'explicit'},episodeIds:[2001],nowMs:900210});
  assert.equal(reserve().reason,'target_busy');
  acquisitions.close();moves.close();acquisitions=openAcquisitionLedger(dbPath);moves=openPureMoveLedger(dbPath);
  const result=await processBonusImport({item:acquisitions.listPendingBonuses({nowMs:900209})[0],acquisitions,pureMoves:moves,now:()=>900209,readEpisode:async()=>({state:'ok',complete:true,files:[]}),verifyPublic:async()=>{throw Error('No file identified')},shokoMount:{appRoot:'/pure',localRoot:root}});
  assert.equal(result.state,'bonus_review');assert.equal(reserve().state,'reserved');
  assert.equal(acquisitions.reserve({requestId:main,candidate:{indexerId:7,guid:'duplicate-main'},episodeIds:[1001],nowMs:900211}).reason,'target_busy');
  assert.deepEqual(moves.getIntent(attemptId).manifest.files,files.map(({evidence,...f})=>f).sort((a,b)=>a.name.localeCompare(b.name,'en')));
 }finally{moves?.close();acquisitions?.close();requests?.close();await rm(root,{recursive:true,force:true});}
});
