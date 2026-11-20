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
