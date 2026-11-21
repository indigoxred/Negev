import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { openAcquisitionLedger } from '../src/acquisition/acquisition-ledger.mjs';
import { openPureMoveLedger } from '../src/acquisition/pure-move-ledger.mjs';

test('one saved torrent gets one durable move intent and publish transition', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-pure-ledger-'));
  const dbPath = path.join(root, 'state.sqlite');
  const hash = 'a'.repeat(40);
  const files = [{ name: 'Show/01.mkv', size: 3, episodeIds: [1001],
    dev: '1', ino: '2', mtimeNs: '3' }];
  let attemptId;
  try {
    const requests = openRequestLedger(dbPath);
    const request = requests.submit({ requesterId: 1, requestKey: 'one', nowMs: 100,
      intent: { state: 'ready', anidbId: 42, kind: 'series', monitorFuture: false,
        episodeIds: [1001] } });
    requests.close();
    const acquisition = openAcquisitionLedger(dbPath);
    const candidate = { indexerId: 7, guid: 'synthetic-release' };
    const attempt = acquisition.reserve({ requestId: request.requestId, candidate,
      episodeIds: [1001], nowMs: 200 });
    attemptId = attempt.attemptId;
    acquisition.bindPreparedTorrent({ attemptId, candidate, hash, nowMs: 201 });
    acquisition.beginDispatch({ attemptId, nowMs: 202 });
    acquisition.recordTorrent({ attemptId, hash, nowMs: 203 });
    acquisition.beginStart({ attemptId, hash,
      manifestDigest: 'c'.repeat(64), nowMs: 204 });
    acquisition.close();
    const input = { attemptId, torrentHash: hash,
      stagingRoot: path.join(root, '.negev-staging', hash),
      holdingPath: path.join(root, 'holding', `negev-${attemptId}-${hash.slice(0, 16)}`),
      files, nowMs: 205 };
    const ledger = openPureMoveLedger(dbPath);
    try {
      assert.deepEqual(ledger.recordIntent(input), { state: 'recorded' });
      assert.deepEqual(ledger.recordIntent(input), { state: 'recorded' });
      assert.deepEqual(ledger.recordIntent({ ...input, files: [{ ...files[0], size: 4 }] }),
        { state: 'held', reason: 'move_intent_conflict' });
      assert.equal(ledger.getIntent(attemptId).status, 'moving');
      assert.deepEqual(ledger.markPrepared({ attemptId, nowMs: 206 }),
        { state: 'prepared' });
    } finally { ledger.close(); }
    const restarted = openPureMoveLedger(dbPath);
    try {
      assert.equal(restarted.getIntent(attemptId).status, 'prepared');
      assert.deepEqual(restarted.beginPublish({ attemptId, nowMs: 207 }),
        { state: 'publish_unknown', sendNow: true });
      assert.deepEqual(restarted.beginPublish({ attemptId, nowMs: 208 }),
        { state: 'publish_unknown', sendNow: false });
      const observed = [{ name: 'Show/01.mkv', fileId: 77,
        releaseEvidence: 'registered' }];
      assert.deepEqual(restarted.recordContentPresent({ attemptId,
        files: observed, nowMs: 209 }),
      { state: 'content_present', publicationProven: false, files: observed });
      assert.deepEqual(restarted.getContentObservation(attemptId),
        { state: 'content_present', publicationProven: false, files: observed });
      assert.deepEqual(restarted.recordContentPresent({ attemptId,
        files: [{ ...observed[0], fileId: 78 }], nowMs: 210 }),
      { state: 'held', reason: 'content_observation_conflict' });
      assert.deepEqual(restarted.markPublished({ attemptId, nowMs: 209 }),
        { state: 'published_observed' });
      assert.equal(restarted.getIntent(attemptId).status, 'published_observed');
    } finally { restarted.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('bonus manifest persists its separate identity and does not enter main content completion',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'negev-bonus-move-')),dbPath=path.join(root,'state.sqlite');const requests=openRequestLedger(dbPath),acq=openAcquisitionLedger(dbPath);let moves;
 try{
  const request=requests.submit({requesterId:1,requestKey:'main',nowMs:100,intent:{state:'ready',anidbId:42,kind:'series',monitorFuture:false,episodeIds:[1001]}});
  const candidate={indexerId:7,guid:'pack'},hash='a'.repeat(40),attemptId=acq.reserve({requestId:request.requestId,candidate,episodeIds:[1001],nowMs:200}).attemptId;
  acq.bindPreparedTorrent({attemptId,candidate,hash,nowMs:201});const main={name:'01.mkv',size:3,episodeIds:[1001]};const bonus={name:'Extras/film.mkv',size:4,anidbId:84,episodeIds:[9001],kind:'movie',evidence:'shoko_filename_prediction'};
  acq.recordFilePlan({attemptId,hash,plannedFiles:[main],nowMs:202});acq.recordBonusPlan({attemptId,hash,files:[bonus],nowMs:203});acq.beginDispatch({attemptId,nowMs:204});acq.recordTorrent({attemptId,hash,nowMs:205});acq.beginStart({attemptId,hash,manifestDigest:'c'.repeat(64),nowMs:206});
  moves=openPureMoveLedger(dbPath);const files=[{...main,dev:'1',ino:'2',mtimeNs:'3'},{...bonus,scope:'bonus',dev:'1',ino:'4',mtimeNs:'5'}];
  const intent={attemptId,torrentHash:hash,stagingRoot:path.join(root,'staging',hash),holdingPath:path.join(root,'holding',`negev-${attemptId}-${hash.slice(0,16)}`),files,nowMs:207};
  assert.equal(moves.recordIntent(intent).state,'recorded');assert.equal(moves.getIntent(attemptId).manifest.files.find(f=>f.scope==='bonus').anidbId,84);
  moves.markPrepared({attemptId,nowMs:208});moves.beginPublish({attemptId,nowMs:209});assert.equal(moves.recordContentPresent({attemptId,files:[{name:main.name,fileId:77,releaseEvidence:'registered'}],nowMs:210}).state,'content_present');
  assert.equal(acq.listPendingBonuses({nowMs:210}).length,1);assert.deepEqual(acq.getAttempt(attemptId).episodeIds,[1001]);
 }finally{moves?.close();acq.close();requests.close();await rm(root,{recursive:true,force:true});}
});

test('pre-start bonus exclusions survive restart and permit a main-only physical move',async()=>{const root=await mkdtemp(path.join(tmpdir(),'negev-bonus-excluded-move-')),dbPath=path.join(root,'state.sqlite');const requests=openRequestLedger(dbPath);let acq=openAcquisitionLedger(dbPath),moves;try{const saved=requests.submit({requesterId:1,requestKey:'excluded',nowMs:1,intent:{state:'ready',anidbId:42,kind:'series',monitorFuture:false,episodeIds:[1001]}}),candidate={indexerId:7,guid:'pack'},hash='a'.repeat(40),attemptId=acq.reserve({requestId:saved.requestId,candidate,episodeIds:[1001],nowMs:2}).attemptId;const main={name:'01.mkv',size:3,episodeIds:[1001]},bonus={name:'Extras/OVA.mkv',size:4,anidbId:43,episodeIds:[2001],kind:'ova',evidence:'shoko_filename_prediction'};acq.bindPreparedTorrent({attemptId,candidate,hash,nowMs:3});acq.recordFilePlan({attemptId,hash,plannedFiles:[main],nowMs:4});acq.recordBonusPlan({attemptId,hash,files:[bonus],nowMs:5});acq.beginDispatch({attemptId,nowMs:6});acq.recordTorrent({attemptId,hash,nowMs:7});assert.equal(acq.excludeUnstartedBonuses({attemptId,names:[bonus.name],nowMs:8}).state,'excluded');acq.close();acq=openAcquisitionLedger(dbPath);assert.deepEqual(acq.getBonusPlan(attemptId),[]);assert.deepEqual(acq.getRecordedBonusPlan(attemptId).files,[]);acq.beginStart({attemptId,hash,manifestDigest:'c'.repeat(64),nowMs:9});assert.equal(acq.excludeUnstartedBonuses({attemptId,names:[],nowMs:10}).reason,'bonus_exclusion_closed');moves=openPureMoveLedger(dbPath);assert.equal(moves.recordIntent({attemptId,torrentHash:hash,stagingRoot:path.join(root,'staging',hash),holdingPath:path.join(root,'holding','negev-'+attemptId+'-'+hash.slice(0,16)),files:[{...main,dev:'1',ino:'2',mtimeNs:'3'}],nowMs:10}).state,'recorded');}finally{moves?.close();acq.close();requests.close();await rm(root,{recursive:true,force:true});}});
