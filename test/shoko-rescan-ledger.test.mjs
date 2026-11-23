import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { openAcquisitionLedger } from '../src/acquisition/acquisition-ledger.mjs';
import { openPureMoveLedger } from '../src/acquisition/pure-move-ledger.mjs';
import { processShokoRescan } from '../src/acquisition/process-shoko-rescan.mjs';
import { openShokoRescanLedger } from '../src/acquisition/shoko-rescan-ledger.mjs';

async function fixture({ policyBeforeAttempt = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-rescan-'));
  const dbPath = path.join(root, 'state.sqlite');
  const requests = openRequestLedger(dbPath);
  const submitted = requests.submit({ requesterId: 1, requestKey: 'pack',
    nowMs: 100, intent: { state: 'ready', anidbId: 42,
      kind: 'series', monitorFuture: false,
      episodeIds: Array.from({ length: 12 }, (_, i) => 1001 + i) } });
  requests.close();
  const acquisition = openAcquisitionLedger(dbPath);
  const moves = openPureMoveLedger(dbPath);
  let rescan = policyBeforeAttempt ? openShokoRescanLedger(dbPath) : null;
  const hash = 'a'.repeat(40);
  const candidate = { indexerId: 7, guid: 'pack' };
  const files = Array.from({ length: 12 }, (_, i) => ({
    name: `group/episode-${String(i + 1).padStart(2, '0')}.mkv`,
    size: 1000 + i, episodeIds: [1001 + i],
    dev: '1', ino: String(i + 2), mtimeNs: '3',
  }));
  const { attemptId } = acquisition.reserve({ requestId: submitted.requestId,
    candidate, episodeIds: files.flatMap((file) => file.episodeIds),
    evidencePolicy: 'first_time_permissive', nowMs: 200 });
  acquisition.bindPreparedTorrent({ attemptId, candidate, hash, nowMs: 201 });
  acquisition.recordFilePlan({ attemptId, hash,
    plannedFiles: files.map(({ name, size, episodeIds }) => ({
      name, size, episodeIds })), nowMs: 202 });
  acquisition.beginDispatch({ attemptId, nowMs: 203 });
  acquisition.recordTorrent({ attemptId, hash, nowMs: 204 });
  acquisition.beginStart({ attemptId, hash,
    manifestDigest: 'c'.repeat(64), nowMs: 205 });
  moves.recordIntent({ attemptId, torrentHash: hash,
    stagingRoot: path.join(root, 'staging', hash),
    holdingPath: path.join(root, 'holding',
      `negev-${attemptId}-${hash.slice(0, 16)}`),
    files, nowMs: 206 });
  moves.markPrepared({ attemptId, nowMs: 207 });
  moves.beginPublish({ attemptId, nowMs: 208 });
  moves.markPublished({ attemptId, nowMs: 209 });
  rescan ??= openShokoRescanLedger(dbPath);
  return { root, dbPath, acquisition, moves, rescan, attemptId, files,
    close: async () => { rescan.close(); moves.close(); acquisition.close();
      await rm(root, { recursive: true, force: true }); } };
}

test('a season pack journals independent one-shot rescans across restart', async () => {
  const saved = await fixture();
  let rescan = saved.rescan;
  try {
    const due = rescan.listDue({ nowMs: 300_209, limit: 20 });
    assert.equal(rescan.isEnrolled(saved.attemptId), true);
    assert.equal(rescan.getAttemptStatus(saved.attemptId), null);
    assert.equal(due.length, 1);
    assert.equal(due[0].attemptId, saved.attemptId);
    assert.equal(due[0].manifest.files.length, 12);
    assert.equal(rescan.observeFile({ attemptId: saved.attemptId,
      fileName: saved.files[2].name, fileId: 81,
      nowMs: 300_209 }).state, 'observed');
    assert.equal(rescan.getAttemptStatus(saved.attemptId), 'pending');
    assert.equal(rescan.beginDispatch({ attemptId: saved.attemptId,
      fileName: saved.files[2].name, fileId: 81,
      nowMs: 359_999 }).state, 'held');
    assert.equal(rescan.beginDispatch({ attemptId: saved.attemptId,
      fileName: saved.files[2].name, fileId: 81,
      nowMs: 360_209 }).state, 'dispatched');
    rescan.close();
    rescan = openShokoRescanLedger(saved.dbPath);
    assert.equal(rescan.beginDispatch({ attemptId: saved.attemptId,
      fileName: saved.files[2].name, fileId: 82,
      nowMs: 360_210 }).state, 'held');
    assert.equal(rescan.beginDispatch({ attemptId: saved.attemptId,
      fileName: saved.files[2].name, fileId: 81,
      nowMs: 360_210 }).state, 'held');
    assert.equal(rescan.markLinked({ attemptId: saved.attemptId,
      fileName: saved.files[2].name, fileId: 81,
      nowMs: 360_211 }).state, 'linked');
    assert.equal(rescan.observeFile({ attemptId: saved.attemptId,
      fileName: saved.files[4].name, fileId: 82,
      nowMs: 360_212 }).state, 'observed');
    assert.equal(rescan.getFile(saved.attemptId, saved.files[2].name).status,
      'linked');
    assert.equal(rescan.getFile(saved.attemptId, saved.files[4].name).status,
      'observed');
  } finally {
    rescan.close(); saved.moves.close(); saved.acquisition.close();
    await rm(saved.root, { recursive: true, force: true });
  }
});

test('unresolved files remain recorded and finished attempts leave the sweep', async () => {
  const saved = await fixture();
  try {
    saved.rescan.observeFile({ attemptId: saved.attemptId,
      fileName: saved.files[0].name, fileId: 91, nowMs: 300_209 });
    saved.rescan.beginDispatch({ attemptId: saved.attemptId,
      fileName: saved.files[0].name, fileId: 91, nowMs: 360_209 });
    assert.equal(saved.rescan.markUnresolved({ attemptId: saved.attemptId,
      fileName: saved.files[0].name, fileId: 91,
      nowMs: 660_209 }).state, 'unresolved');
    saved.rescan.delayAttempt({ attemptId: saved.attemptId,
      nextDueMs: 720_209, nowMs: 660_210 });
    assert.equal(saved.rescan.listDue({ nowMs: 700_000 }).length, 0);
    assert.equal(saved.rescan.listDue({ nowMs: 720_209 }).length, 1);
    saved.rescan.endAttempt({ attemptId: saved.attemptId,
      review: true, nowMs: 720_210 });
    assert.equal(saved.rescan.listDue({ nowMs: 900_000 }).length, 0);
    assert.equal(saved.rescan.listDue({ nowMs: 1_020_210 }).length, 1);
    saved.rescan.endAttempt({attemptId:saved.attemptId,review:false,nowMs:1_020_211});
    assert.equal(saved.rescan.listReviewNeeded().length,0);
    assert.equal(saved.rescan.getFile(saved.attemptId,
      saved.files[0].name).status, 'unresolved');
  } finally { await saved.close(); }
});

test('an existing active import predating the policy can be reconciled without a new download', async () => {
  const saved = await fixture({ policyBeforeAttempt: false });
  try {
    assert.equal(saved.rescan.isEnrolled(saved.attemptId), true);
    assert.equal(saved.rescan.listDue({ nowMs: 900_000 }).length, 1);
  } finally { await saved.close(); }
});


test('recovery classification persists across restart and clears with proof',async()=>{
 const saved=await fixture();let ledger=saved.rescan;try{
 ledger.recordObservation({attemptId:saved.attemptId,state:'awaiting_plex',reason:'plex_publication_pending',nowMs:300209});
 ledger.close();ledger=openShokoRescanLedger(saved.dbPath);
 assert.equal(ledger.getObservation(saved.attemptId).reason,'plex_publication_pending');
 ledger.endAttempt({attemptId:saved.attemptId,review:true,nowMs:300210});
 ledger.recordObservation({attemptId:saved.attemptId,state:'linked',reason:'playable',nowMs:700000});
 ledger.endAttempt({attemptId:saved.attemptId,review:false,nowMs:700000});
 assert.equal(ledger.listReviewNeeded().length,0);
 }finally{ledger.close();saved.moves.close();saved.acquisition.close();await rm(saved.root,{recursive:true,force:true});}
});


test('retry scheduling cannot clear an existing review without exact playback success',async()=>{
 const saved=await fixture();try{
 saved.rescan.endAttempt({attemptId:saved.attemptId,review:true,nowMs:300209});
 saved.rescan.delayAttempt({attemptId:saved.attemptId,nextDueMs:420209,nowMs:360209});
 assert.equal(saved.rescan.getAttemptStatus(saved.attemptId),'review');
 assert.equal(saved.rescan.listReviewNeeded().length,1);
 saved.rescan.endAttempt({attemptId:saved.attemptId,review:false,nowMs:420209});
 assert.equal(saved.rescan.listReviewNeeded().length,0);
 }finally{await saved.close();}
});


test('urgent recovery can lead historical backfill while ordinary turns retain age ordering',async()=>{
 const saved=await fixture();let d;try{const requests=openRequestLedger(saved.dbPath);const urgent=requests.submit({requesterId:2,requestKey:'urgent',nowMs:400000000,intent:{state:'ready',anidbId:43,kind:'series',monitorFuture:false,episodeIds:saved.files.flatMap(f=>f.episodeIds)}});requests.close();d=new DatabaseSync(saved.dbPath);const id=Number(d.prepare(`INSERT INTO acquisition_attempts(request_id,anidb_id,indexer_id,candidate_digest,status,torrent_hash,created_ms,updated_ms) SELECT ?,anidb_id+1,indexer_id,?,status,torrent_hash,400000000,400000000 FROM acquisition_attempts WHERE id=?`).run(urgent.requestId,'b'.repeat(64),saved.attemptId).lastInsertRowid);
 d.prepare('INSERT INTO acquisition_target_claims(attempt_id,anidb_id,episode_id,active) SELECT ?,anidb_id+1,episode_id,active FROM acquisition_target_claims WHERE attempt_id=?').run(id,saved.attemptId);
 d.prepare('INSERT INTO pure_move_intents SELECT ?,torrent_hash,manifest_digest,manifest_json,status,400000000,400000000 FROM pure_move_intents WHERE attempt_id=?').run(id,saved.attemptId);
 d.prepare("INSERT INTO shoko_rescan_attempts VALUES(?,'review',400300000,400300000)").run(id);d.close();d=null;
 assert.equal(saved.rescan.listDue({nowMs:400600000,limit:1,preferUrgent:true})[0].attemptId,id);
 assert.equal(saved.rescan.listDue({nowMs:400600000,limit:1,preferUrgent:false})[0].attemptId,saved.attemptId);
 }finally{d?.close();await saved.close();}
});


test('dispatch evidence remains independent of the overwritten final row and survives restart',async()=>{const x=await fixture();let ledger=x.rescan;try{const input={attemptId:x.attemptId,fileName:x.files[0].name,fileId:81};ledger.observeFile({...input,nowMs:300209});ledger.beginDispatch({...input,nowMs:360209});ledger.recordDispatchResult({...input,result:'accepted',nowMs:360210});ledger.markLinked({...input,nowMs:360211});ledger.close();ledger=openShokoRescanLedger(x.dbPath);assert.equal(ledger.getFile(x.attemptId,input.fileName).status,'linked');assert.deepEqual(ledger.listEvents({attemptId:x.attemptId}).map(e=>[e.event,e.observedMs]),[['observed',300209],['dispatch',360209],['accepted',360210],['linked',360211]]);assert.equal(ledger.beginDispatch({...input,nowMs:360212}).state,'held');assert.equal(ledger.listEvents({attemptId:x.attemptId}).length,4);}finally{ledger.close();x.moves.close();x.acquisition.close();await rm(x.root,{recursive:true,force:true})}});


test('actual recovery worker retains one outbound receipt and later exact success after restart',async()=>{const x=await fixture();let ledger=x.rescan,linked=false,calls=0,clock=300209;try{const item=ledger.listDue({nowMs:clock})[0];const options={item,importRoot:path.join(x.root,'source','Negev'),shokoMount:{localRoot:x.root,appRoot:'/pure'},now:()=>clock,readQueue:async()=>({state:'queue_idle_unverified'}),readFile:async({sourcePath})=>{const index=x.files.findIndex(f=>sourcePath.endsWith(f.name));const f=x.files[index];return[{ID:81+index,Size:f.size,Locations:[{AbsolutePath:sourcePath,IsAccessible:true}],SeriesIDs:index===0&&!linked?[]:[{SeriesID:{ID:4,AniDB:42},EpisodeIDs:[{AniDB:f.episodeIds[0]}]}]}]},rescan:async({fileId})=>{assert.equal(fileId,81);assert.equal(ledger.listEvents({attemptId:x.attemptId}).filter(e=>e.event==='dispatch').length,1);calls++;clock+=5;return{state:'accepted'}},verifyPlex:async({episodeId})=>({state:'available',fileId:81+episodeId-1001})};
assert.equal((await processShokoRescan({...options,ledger,nowMs:clock})).state,'observed');clock=360209;assert.equal((await processShokoRescan({...options,ledger,nowMs:clock})).state,'rescan_requested');assert.equal(calls,1);ledger.close();ledger=openShokoRescanLedger(x.dbPath);linked=true;clock=420209;assert.equal((await processShokoRescan({...options,ledger,nowMs:clock})).state,'linked');assert.equal(calls,1);const events=ledger.listEvents({attemptId:x.attemptId}).filter(e=>e.fileName===x.files[0].name);assert.deepEqual(events.map(e=>e.event),['observed','dispatch','accepted','linked']);assert.equal(events[2].observedMs,360214);assert.equal(events[3].observedMs,420209);}finally{ledger.close();x.moves.close();x.acquisition.close();await rm(x.root,{recursive:true,force:true})}});

test('old linked schema gains the event table without fabricating a historical dispatch',async()=>{const x=await fixture();let ledger=x.rescan;try{const input={attemptId:x.attemptId,fileName:x.files[0].name,fileId:81};ledger.observeFile({...input,nowMs:300209});ledger.markLinked({...input,nowMs:300210});ledger.close();const old=new DatabaseSync(x.dbPath);old.exec('DROP TABLE shoko_rescan_events');old.close();ledger=openShokoRescanLedger(x.dbPath);assert.deepEqual(ledger.listEvents({attemptId:x.attemptId}),[]);assert.equal(ledger.getFile(x.attemptId,input.fileName).status,'linked');ledger.markLinked({...input,nowMs:300211});assert.deepEqual(ledger.listEvents({attemptId:x.attemptId}),[]);}finally{ledger.close();x.moves.close();x.acquisition.close();await rm(x.root,{recursive:true,force:true})}});
