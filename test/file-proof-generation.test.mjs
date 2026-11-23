import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openFileProofLedger } from
  '../src/availability/file-proof-ledger.mjs';
import { openShokoInventoryLedger } from
  '../src/availability/shoko-inventory-worker.mjs';
import { openPlexCardIndex } from
  '../src/availability/plex-card-index.mjs';

const target = { anidbId: 42, episodeId: 1001 };
const item = (updated = '2026-11-02T00:00:00Z') => ({ fileId: 7,
  updated, state: 'linked', pairs: [target] });
const card = (suffix = 'a', candidateKey = '1:2:5') => ({
  libraryId: 102, ratingKey: 500, kind: 'episode',
  parts: [{ libraryId: 102, partId: 600, size: 5,
    plexPath: `/source-pure/episode-${suffix}.mkv`, candidateKey }] });
const snapshot = (dbPath) => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const source = db.prepare(`SELECT updated,observed_ms AS observedMs
      FROM shoko_inventory_files WHERE file_id=7`).get();
    const cardRevision = db.prepare(`SELECT observed_ms AS observedMs,
      identity_signature AS identitySignature FROM plex_card_observations
      WHERE library_id=102 AND rating_key=500`).get();
    return { source, card: cardRevision };
  } finally { db.close(); }
};

test('a late proof insert cannot escape an already delivered Shoko change', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-proof-generation-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const shoko = openShokoInventoryLedger(dbPath);
  const plex = openPlexCardIndex(dbPath);
  const proofs = openFileProofLedger(dbPath, { positiveLifetimeMs: 1_000,
    now: () => 500 });
  try {
    shoko.recordFileObservation({ item: item(), observedMs: 100 });
    plex.recordCard({ ...card(), observedMs: 100 });
    const revision = snapshot(dbPath);
    shoko.recordFileObservation({ item: item('2026-11-02T01:00:00Z'),
      observedMs: 250 });
    assert.deepEqual(proofs.observeGuarded({ ...target, checkedMs: 300,
      proof: { fileId: 7, libraryId: 102, ratingKey: 500,
        partId: 600, storageKey: '1:2:5' }, revision }),
    { state: 'held', reason: 'source_generation_changed' });
    assert.deepEqual(proofs.getCurrent(target), { state: 'unknown' });
  } finally {
    proofs.close(); plex.close(); shoko.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a changed Plex card or physical Part cannot receive a late exact proof', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-proof-generation-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const shoko = openShokoInventoryLedger(dbPath);
  const plex = openPlexCardIndex(dbPath);
  const proofs = openFileProofLedger(dbPath, { positiveLifetimeMs: 1_000,
    now: () => 500 });
  try {
    shoko.recordFileObservation({ item: item(), observedMs: 100 });
    plex.recordCard({ ...card(), observedMs: 100 });
    const revision = snapshot(dbPath);
    plex.recordCard({ ...card('b', '1:3:5'), observedMs: 250 });
    const proof = { fileId: 7, libraryId: 102, ratingKey: 500,
      partId: 600, storageKey: '1:2:5' };
    assert.deepEqual(proofs.observeGuarded({ ...target, proof,
      checkedMs: 300, revision }),
    { state: 'held', reason: 'source_generation_changed' });
    assert.deepEqual(proofs.observeGuarded({ ...target, proof,
      checkedMs: 300, revision: snapshot(dbPath) }),
    { state: 'held', reason: 'source_generation_changed' });
    assert.deepEqual(proofs.getCurrent(target), { state: 'unknown' });
    assert.deepEqual(proofs.observeGuarded({ ...target,
      proof: { ...proof, storageKey: '1:3:5' }, checkedMs: 300,
      revision: snapshot(dbPath) }), { state: 'recorded' });
    assert.deepEqual(proofs.observeGuarded({ ...target,
      proof: { ...proof, storageKey: '1:3:5',
        presentation: 'alternate_card' }, checkedMs: 301,
      revision: snapshot(dbPath) }), { state: 'recorded' });
    assert.deepEqual(proofs.getCurrent(target), { state: 'available',
      verifiedAtMs: 301, presentation: 'alternate_card' });
  } finally {
    proofs.close(); plex.close(); shoko.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a proof holds when its source ledgers are not installed', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'negev-proof-generation-'));
  const proofs = openFileProofLedger(path.join(dir, 'state.sqlite'),
    { positiveLifetimeMs: 1_000, now: () => 500 });
  try {
    assert.deepEqual(proofs.observeGuarded({ ...target, checkedMs: 300,
      proof: { fileId: 7, libraryId: 102, ratingKey: 500,
        partId: 600, storageKey: '1:2:5' },
      revision: { source: { updated: '2026-11-02T00:00:00Z',
        observedMs: 100 }, card: { observedMs: 100,
        identitySignature: 'synthetic' } } }),
    { state: 'held', reason: 'source_generation_changed' });
  } finally { proofs.close(); await rm(dir, { recursive: true, force: true }); }
});

test('composite canonical proof requires all component generations across restart and invalidation',async()=>{const root=await mkdtemp(path.join(os.tmpdir(),'negev-composite-proof-')),dbPath=path.join(root,'state.sqlite');const inventory=openShokoInventoryLedger(dbPath),index=openPlexCardIndex(dbPath);let proofs=openFileProofLedger(dbPath,{positiveLifetimeMs:1000,now:()=>500});try{for(const id of[7,8])inventory.recordFileObservation({item:{...item(),fileId:id},observedMs:100});const parts=[7,8].map((fileId,i)=>({fileId,libraryId:102,ratingKey:500,partId:600+i,mediaId:700,partIndex:i,partCount:2,storageKey:'1:'+(2+i)+':5'}));index.recordCard({libraryId:102,ratingKey:500,kind:'episode',observedMs:100,parts:parts.map(p=>({...p,candidateKey:p.storageKey,size:5,plexPath:'/pure/'+p.fileId+'.mkv'}))});const revision={...snapshot(dbPath),sources:[7,8].map(fileId=>({fileId,updated:item().updated,observedMs:100}))};assert.equal(proofs.observeGuarded({...target,proof:{...parts[0],parts},revision,checkedMs:200}).state,'recorded');proofs.close();proofs=openFileProofLedger(dbPath,{positiveLifetimeMs:1000,now:()=>500});assert.equal(proofs.getCurrent(target).state,'available');inventory.recordFileObservation({item:{...item('2026-11-23T00:00:00Z'),fileId:8},observedMs:300});assert.notEqual(proofs.getCurrent(target).state,'available');assert.deepEqual(proofs.getRecentAvailableIds({anidbId:42}),[]);assert.equal(proofs.listCurrentTitles().items.length,0);}finally{proofs.close();index.close();inventory.close();await rm(root,{recursive:true,force:true})}});

test('an on-demand composite check flows through the real durable worker into all-component proof',async()=>{const{openDirectAvailabilityQueue,createDirectAvailabilityWorker}=await import('../src/availability/direct-availability-queue.mjs');const{createRecordArrivalProof}=await import('../src/availability/record-arrival-proof.mjs');const{queueCompositeObservation}=await import('../src/availability/queue-composite-observation.mjs');const root=await mkdtemp(path.join(os.tmpdir(),'negev-composite-worker-')),dbPath=path.join(root,'state.sqlite'),inventory=openShokoInventoryLedger(dbPath),index=openPlexCardIndex(dbPath),proofs=openFileProofLedger(dbPath,{positiveLifetimeMs:1000,now:()=>500}),queue=openDirectAvailabilityQueue(dbPath);try{for(const id of[7,8])inventory.recordFileObservation({item:{...item(),fileId:id},observedMs:100});const parts=[7,8].map((fileId,i)=>({fileId,libraryId:102,ratingKey:500,partId:600+i,mediaId:700,partIndex:i,partCount:2,storageKey:'1:'+(2+i)+':5'}));index.recordCard({libraryId:102,ratingKey:500,kind:'episode',observedMs:100,parts:parts.map(p=>({...p,candidateKey:p.storageKey,size:5,plexPath:'/pure/'+p.fileId+'.mkv'}))});const outcome={state:'available',multipart:true,fileIds:[7,8],proof:{...parts[0],parts,presentation:'alternate_card'},cardRevision:index.getCardRevision({libraryId:102,ratingKey:500})};queueCompositeObservation({queue,target,result:outcome,nowMs:200});assert.equal(queue.getStatus({...target,nowMs:200}).state,'unknown');const recorder=createRecordArrivalProof({inventory,proofs,cursor:{confirmRecentFile:()=>({state:'unchanged'}),prioritizeFile:()=>{}},now:()=>500});const worker=createDirectAvailabilityWorker({queue,requireProof:true,observeTarget:async()=>outcome,onRecordedAvailable:recorder,now:()=>500});assert.equal((await worker.runOnce()).result,'available');assert.equal(proofs.getCurrent(target).state,'available');assert.equal(proofs.listCurrentTitles().items[0].verifiedEpisodeCount,1);assert.equal(proofs.getCurrent(target).presentation,'alternate_card');const beforeAlternate=queue.getObservation(target);queueCompositeObservation({queue,target,result:outcome,nowMs:500,canonicalAvailable:true,canonicalPresentation:'alternate_card'});assert.deepEqual(queue.getObservation(target),beforeAlternate);outcome.proof={...parts[0],parts};queueCompositeObservation({queue,target,result:outcome,nowMs:500,canonicalAvailable:true,canonicalPresentation:'alternate_card'});assert.equal((await worker.runOnce()).result,'available');assert.equal(proofs.getCurrent(target).presentation,undefined);const beforeRepeat=queue.getObservation(target);queueCompositeObservation({queue,target,result:outcome,nowMs:500,canonicalAvailable:true,canonicalPresentation:undefined});assert.deepEqual(queue.getObservation(target),beforeRepeat);inventory.recordFileObservation({item:{...item('2026-11-23T01:00:00Z'),fileId:8},observedMs:600});const db=new DatabaseSync(dbPath,{readOnly:true});assert.equal(db.prepare('select count(*) n from file_availability_proofs').get().n,0);db.close();queue.enqueue({...target,observedMs:600,priority:'event'});assert.equal(queue.getStatus({...target,nowMs:600}).state,'unknown');}finally{queue.close();proofs.close();index.close();inventory.close();await rm(root,{recursive:true,force:true})}});

test('unguarded composite proof is never accepted as an individual complete file',async()=>{const root=await mkdtemp(path.join(os.tmpdir(),'negev-composite-unguarded-')),dbPath=path.join(root,'state.sqlite'),proofs=openFileProofLedger(dbPath,{positiveLifetimeMs:1000,now:()=>500});try{assert.equal(proofs.observe({...target,proof:{fileId:7,libraryId:102,ratingKey:500,partId:600,parts:[{fileId:7},{fileId:8}]},checkedMs:200}).state,'held');assert.equal(proofs.getCurrent(target).state,'unknown');}finally{proofs.close();await rm(root,{recursive:true,force:true})}});

test('actual v300 scalar writer migrates against current multipart metadata while ordinary proof survives',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'negev-composite-migration-')),dbPath=path.join(root,'state.sqlite'),index=openPlexCardIndex(dbPath);let proofs;
  try {
    const source=await readFile(new URL('./fixtures/file-proof-ledger-v300.mjs.txt',import.meta.url));
    assert.equal(createHash('sha256').update(source).digest('hex'),'36a63d0f3da3ac9cc77e1f4e675ad85f0cc0c922454aaac3a9323b9a55863897');
    const writerPath=path.join(root,'writer-v300.mjs');await writeFile(writerPath,source);
    const {openFileProofLedger:openOld}=await import(pathToFileURL(writerPath).href);
    index.recordCard({libraryId:102,ratingKey:500,kind:'episode',observedMs:100,parts:[0,1].map(i=>({libraryId:102,partId:600+i,size:5,plexPath:'/pure/'+i+'.mkv',mediaId:700,partIndex:i,partCount:2}))});
    proofs=openOld(dbPath,{positiveLifetimeMs:1000,now:()=>500});
    proofs.observe({...target,proof:{fileId:7,libraryId:102,ratingKey:500,partId:600},checkedMs:100});
    proofs.observe({anidbId:43,episodeId:1002,proof:{fileId:9,libraryId:102,ratingKey:501,partId:602},checkedMs:100});
    proofs.close();proofs=null;
    proofs=openFileProofLedger(dbPath,{positiveLifetimeMs:1000,now:()=>500});
    assert.equal(proofs.getCurrent(target).state,'unknown');
    assert.equal(proofs.getCurrent({anidbId:43,episodeId:1002}).state,'available');
  } finally {proofs?.close();index.close();await rm(root,{recursive:true,force:true});}
});
