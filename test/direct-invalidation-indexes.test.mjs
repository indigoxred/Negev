import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {mkdtemp,rm} from 'node:fs/promises';import path from 'node:path';import {tmpdir} from 'node:os';
import {openDirectAvailabilityQueue} from '../src/availability/direct-availability-queue.mjs';
for(const legacy of [false,true])test('actual direct-proof invalidations use indexes after '+(legacy?'legacy reopen':'fresh creation'),async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'negev-invalidation-index-')),dbPath=path.join(dir,'db.sqlite');let queue,db;
 try{
  queue=openDirectAvailabilityQueue(dbPath);db=new DatabaseSync(dbPath);queue.close();queue=null;
  if(legacy)db.exec('DROP INDEX IF EXISTS direct_proof_file;DROP INDEX IF EXISTS direct_proof_card');
  db.exec('BEGIN IMMEDIATE');const insert=db.prepare("INSERT INTO direct_availability_targets(anidb_id,episode_id,observed_ms,due_ms,version,state,verified_ms,proof_file_id,proof_library_id,proof_rating_key,proof_part_id) VALUES(1,?,1,2,1,'available',1,?,1,?,?)");
  for(let id=1;id<=10000;id++)insert.run(id,id,id,id);db.exec('COMMIT');
  const before=db.prepare('SELECT * FROM direct_availability_targets WHERE episode_id IN(1,5000,10000)').all();queue=openDirectAvailabilityQueue(dbPath);
  assert.deepEqual(db.prepare('SELECT * FROM direct_availability_targets WHERE episode_id IN(1,5000,10000)').all(),before);
  for(const [where,args] of [["proof_file_id=? AND state='available'",[5000]],["proof_library_id=? AND proof_rating_key=? AND state='available'",[1,5000]]]){
   const plan=db.prepare('EXPLAIN QUERY PLAN UPDATE direct_availability_targets SET state=\'pending\' WHERE '+where).all(...args).map(row=>row.detail).join(' ');
   assert.match(plan,/SEARCH direct_availability_targets/,'no full-table scan: '+plan);
  }
 }finally{queue?.close();db?.close();await rm(dir,{recursive:true,force:true});}
});
