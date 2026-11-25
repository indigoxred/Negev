import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openCandidateCheckCache } from '../src/acquisition/candidate-check-cache.mjs';

const request = { id: 1, anidbId: 42, kind: 'series', episodeIds: [1001] };
const candidate = { indexerId: 7, guid: 'private-candidate-guid', title: 'Example - 01', size: 1000 };

test('deterministic candidate evidence survives restart without raw GUIDs; transient failures do not', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'negev-candidate-cache-'));
  const dbPath = path.join(dir, 'state.sqlite');
  let clock = 100, cache = openCandidateCheckCache(dbPath, { now: () => clock });
  try {
    const key = { request, candidate };
    cache.put({ ...key, result: { state: 'held', reason: 'shoko_preview_wrong_identity' } });
    cache.close(); cache = openCandidateCheckCache(dbPath, { now: () => clock });
    assert.equal(cache.get(key).reason, 'shoko_preview_wrong_identity');
    assert.equal(cache.get({ ...key, candidate: { ...candidate, size: 999 } }), null);
    cache.put({ ...key, candidate: { ...candidate, guid: 'outage' },
      result: { state: 'held', reason: 'provider_unavailable' } });
    assert.equal(cache.get({ ...key, candidate: { ...candidate, guid: 'outage' } }), null);
    cache.invalidateTarget({ anidbId: 42, episodeId: 1001 });
    assert.equal(cache.get(key), null);
    cache.close();
    assert.equal((await readFile(dbPath)).includes(Buffer.from(candidate.guid)), false);
    cache = openCandidateCheckCache(dbPath, { now: () => clock });
  } finally { cache.close(); await rm(dir, { recursive: true, force: true }); }
});


test('earlier preview-policy rejections are not replayed after the policy changes',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'negev-cache-policy-')),dbPath=path.join(dir,'db.sqlite');let cache=openCandidateCheckCache(dbPath,{now:()=>100});
 try{
  cache.close();const db=new DatabaseSync(dbPath);
  const key=createHash('sha256').update(JSON.stringify(['candidate-check-v1',request.id,request.anidbId,request.kind,[...request.episodeIds],candidate.indexerId,request.title,candidate.guid,candidate.title,candidate.size,candidate.sourceQuery,candidate.targetEpisodeId])).digest('hex');
  db.prepare('INSERT INTO acquisition_candidate_checks VALUES(?,?,?,?,?,?)').run(key,42,JSON.stringify([1001]),JSON.stringify({state:'held',reason:'shoko_preview_wrong_identity'}),100,21600100);db.close();
  cache=openCandidateCheckCache(dbPath,{now:()=>100});assert.equal(cache.get({request,candidate}),null);
  cache.put({request,candidate,result:{state:'preflight',shokoPreview:'uncertain',shokoPreviewConflict:'absolute_number_offset',episodeIds:[1001]}});
  assert.equal(cache.get({request,candidate}).shokoPreviewConflict,'absolute_number_offset');
 }finally{cache.close();await rm(dir,{recursive:true,force:true});}
});

test('legacy season-mismatch decisions are reconsidered without flushing other evidence',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'negev-text-season-cache-')),dbPath=path.join(dir,'state.sqlite');let cache=openCandidateCheckCache(dbPath,{now:()=>100});cache.close();
 const legacyKey=c=>createHash('sha256').update(JSON.stringify(['candidate-check-v4-bonuses',request.id,request.anidbId,request.kind,[...request.episodeIds],c.indexerId,request.title,c.guid,c.title,c.size,c.sourceQuery,c.targetEpisodeId])).digest('hex');
 const other={...candidate,guid:'unrelated-cache'},positive={...candidate,guid:'positive-cache'};const db=new DatabaseSync(dbPath);
 for(const [c,result]of [[candidate,{state:'held',reason:'related_installment_mismatch'}],[other,{state:'held',reason:'shoko_preview_wrong_identity'}],[positive,{state:'preflight',episodeIds:[1001]}]])db.prepare('INSERT INTO acquisition_candidate_checks VALUES(?,?,?,?,?,?)').run(legacyKey(c),42,'[1001]',JSON.stringify(result),100,21600100);db.close();
 cache=openCandidateCheckCache(dbPath,{now:()=>100});try{
  assert.equal(cache.get({request,candidate}),null);
  assert.equal(cache.get({request,candidate:other}).reason,'shoko_preview_wrong_identity');
  assert.equal(cache.get({request,candidate:positive}).state,'preflight');
  const result={state:'held',reason:'related_installment_mismatch'};cache.put({request,candidate,result});
  assert.deepEqual(cache.get({request,candidate}),result);cache.close();cache=openCandidateCheckCache(dbPath,{now:()=>101});assert.deepEqual(cache.get({request,candidate}),result);
 }finally{cache.close();await rm(dir,{recursive:true,force:true});}
});

test('textual episode-title revisions recheck both cached title and season mismatches across restart',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'negev-text-episode-cache-')),dbPath=path.join(dir,'state.sqlite');let cache=openCandidateCheckCache(dbPath,{now:()=>100});cache.close();
 const key=c=>createHash('sha256').update(JSON.stringify(['candidate-check-v4-bonuses',request.id,request.anidbId,request.kind,[...request.episodeIds],c.indexerId,request.title,c.guid,c.title,c.size,c.sourceQuery,c.targetEpisodeId])).digest('hex');
 const cases=[['title',{state:'held',reason:'release_title_mismatch'}],['season',{state:'held',reason:'related_installment_mismatch',_relatedGuardRevision:'trusted-title-season-v1'}]];
 const db=new DatabaseSync(dbPath);for(const [guid,result]of cases){const c={...candidate,guid};db.prepare('INSERT INTO acquisition_candidate_checks VALUES(?,?,?,?,?,?)').run(key(c),42,'[1001]',JSON.stringify(result),100,21600100);}db.close();
 cache=openCandidateCheckCache(dbPath,{now:()=>101});try{
  for(const [guid,legacy]of cases){const c={...candidate,guid};assert.equal(cache.get({request,candidate:c}),null,'old '+legacy.reason+' must not hold the saved request');
   const result={state:'held',reason:legacy.reason};cache.put({request,candidate:c,result});assert.deepEqual(cache.get({request,candidate:c}),result);}
  cache.close();cache=openCandidateCheckCache(dbPath,{now:()=>102});for(const [guid,result]of cases)assert.deepEqual(cache.get({request,candidate:{...candidate,guid}}),{state:'held',reason:result.reason});
 }finally{cache.close();await rm(dir,{recursive:true,force:true});}
});


test('v298 season and video-budget negatives recheck while fresh decisions remain reusable',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'negev-year-pack-cache-')),dbPath=path.join(dir,'state.sqlite');let cache=openCandidateCheckCache(dbPath,{now:()=>100});cache.close();
 const key=c=>createHash('sha256').update(JSON.stringify(['candidate-check-v4-bonuses',request.id,request.anidbId,request.kind,[...request.episodeIds],c.indexerId,request.title,c.guid,c.title,c.size,c.sourceQuery,c.targetEpisodeId])).digest('hex');
 const cases=[['year',{state:'held',reason:'related_installment_mismatch',_relatedGuardRevision:'trusted-title-season-v2'}],['pack',{state:'held',reason:'video_budget_exceeded'}]];
 const db=new DatabaseSync(dbPath);for(const [guid,result]of cases){const c={...candidate,guid};db.prepare('INSERT INTO acquisition_candidate_checks VALUES(?,?,?,?,?,?)').run(key(c),42,'[1001]',JSON.stringify(result),100,21600100);}db.close();
 cache=openCandidateCheckCache(dbPath,{now:()=>101});try{
  for(const [guid,old]of cases){const c={...candidate,guid};assert.equal(cache.get({request,candidate:c}),null);cache.put({request,candidate:c,result:{state:'held',reason:old.reason}});}
  cache.close();cache=openCandidateCheckCache(dbPath,{now:()=>102});
  for(const [guid,old]of cases)assert.deepEqual(cache.get({request,candidate:{...candidate,guid}}),{state:'held',reason:old.reason});
 }finally{cache.close();await rm(dir,{recursive:true,force:true});}
});

 test('v317 rechecks legacy provider-derived title rejection once across reopen',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'negev-provider-cache-')),dbPath=path.join(dir,'state.sqlite');let cache=openCandidateCheckCache(dbPath,{now:()=>100});cache.close();
 const key=createHash('sha256').update(JSON.stringify(['candidate-check-v4-bonuses',request.id,request.anidbId,request.kind,[...request.episodeIds],candidate.indexerId,request.title,candidate.guid,candidate.title,candidate.size,candidate.sourceQuery,candidate.targetEpisodeId])).digest('hex');
 const db=new DatabaseSync(dbPath);db.prepare('INSERT INTO acquisition_candidate_checks VALUES(?,?,?,?,?,?)').run(key,42,'[1001]',JSON.stringify({state:'held',reason:'release_title_mismatch',_titleIdentityRevision:'literal-season-title-v1'}),100,21600100);db.close();
 cache=openCandidateCheckCache(dbPath,{now:()=>101});try{assert.equal(cache.get({request,candidate}),null);cache.put({request,candidate,result:{state:'held',reason:'provider_unavailable'}});assert.equal(cache.get({request,candidate}),null);cache.put({request,candidate,result:{state:'held',reason:'release_title_mismatch'}});cache.close();cache=openCandidateCheckCache(dbPath,{now:()=>102});assert.deepEqual(cache.get({request,candidate}),{state:'held',reason:'release_title_mismatch'});}finally{cache.close();await rm(dir,{recursive:true,force:true});}
 });

test('new broad provenance rechecks legacy targeted rejection while preserving unrelated evidence across reopen',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'negev-broad-cache-')),dbPath=path.join(dir,'state.sqlite');
 const narrow={...candidate,sourceQuery:'Example 01',targetEpisodeId:1001},broad={...narrow,broadSourceQuery:'Example'};
 let cache=openCandidateCheckCache(dbPath,{now:()=>100});try{
  cache.put({request,candidate:narrow,result:{state:'held',reason:'targeted_result_wrong_episode'}});
  cache.put({request,candidate,result:{state:'held',reason:'shoko_preview_wrong_identity'}});
  cache.close();cache=openCandidateCheckCache(dbPath,{now:()=>101});
  assert.equal(cache.get({request,candidate:broad}),null);
  assert.equal(cache.get({request,candidate:narrow}).reason,'targeted_result_wrong_episode');
  assert.equal(cache.get({request,candidate}).reason,'shoko_preview_wrong_identity');
  cache.put({request,candidate:broad,result:{state:'preflight',episodeIds:[1001]}});
  cache.close();cache=openCandidateCheckCache(dbPath,{now:()=>102});assert.equal(cache.get({request,candidate:broad}).state,'preflight');
 }finally{cache.close();await rm(dir,{recursive:true,force:true});}
});
