import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openFileBackfillCursor} from '../src/availability/file-backfill-cursor.mjs';

test('actual frozen v317 in-flight arrival migrates once, preserving age and later retry across reopen',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'negev-arrival-upgrade-')),file=path.join(dir,'state.sqlite');
  const prior=new DatabaseSync(file);
  prior.exec(await readFile(new URL('./fixtures/file-backfill-schema-v317.sql',import.meta.url),'utf8'));
  prior.exec(`INSERT INTO file_backfill_cursor VALUES(1,4,2,7,'[51]',100,0,NULL,1);
    INSERT INTO file_backfill_priority VALUES(51,1);
    INSERT INTO file_backfill_recent_events VALUES(51,1800100,0);
    CREATE TABLE unrelated_state(id INTEGER PRIMARY KEY,value TEXT);INSERT INTO unrelated_state VALUES(1,'keep');`);prior.close();
  let cursor=openFileBackfillCursor(file);const inventory={listFileHintIds:()=>[]};
  const finish=(claim,nowMs)=>cursor.record({claim,outcomes:[{fileId:51,state:'unknown'}],nowMs});
  try{
    const oldClaim=cursor.claim({inventory,nowMs:2000100});assert.equal(oldClaim.receipt,7);assert.equal(oldClaim.claimedMs,100);finish(oldClaim,2000101);
    assert.equal(cursor.claim({inventory,nowMs:2000102}).state,'idle');
    cursor.close();cursor=openFileBackfillCursor(file);
    const check=new DatabaseSync(file);const row=check.prepare('SELECT * FROM file_backfill_arrivals WHERE file_id=51').get();
    assert.equal(row.observed_ms,100);assert.equal(row.due_ms,2300101);assert.equal(row.attempts,1);assert.equal(check.prepare('SELECT value FROM unrelated_state').get().value,'keep');assert.equal(check.prepare('PRAGMA quick_check').get().quick_check,'ok');check.close();
    assert.equal(cursor.claim({inventory,nowMs:2000104}).state,'idle');
    const due=cursor.claim({inventory,nowMs:2300101});assert.deepEqual(due.fileIds,[51]);assert.equal(due.claimedMs,2300101);
  }finally{cursor.close();await rm(dir,{recursive:true,force:true});}
});

test('frozen317 in-flight card-priority claim without a recent marker keeps retry after upgrade',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'negev-pending-card-upgrade-')),file=path.join(dir,'state.sqlite'),old=new DatabaseSync(file);old.exec(await readFile(new URL('./fixtures/file-backfill-schema-v317.sql',import.meta.url),'utf8'));old.exec(`INSERT INTO file_backfill_cursor VALUES(1,0,1,1,'[51]',100,0,NULL,1);INSERT INTO file_backfill_priority VALUES(51,1)`);old.close();let cursor=openFileBackfillCursor(file);
 try{const inventory={listFileHintIds:()=>[]},pending=cursor.claim({inventory,nowMs:101});assert.equal(pending.claimedMs,100);cursor.record({claim:pending,outcomes:[{fileId:51,state:'unknown'}],nowMs:102});cursor.close();cursor=openFileBackfillCursor(file);assert.deepEqual(cursor.claim({inventory,nowMs:60102}).fileIds,[51]);const d=new DatabaseSync(file);const age=d.prepare('SELECT observed_ms FROM file_backfill_arrivals WHERE file_id=51').get()?.observed_ms;d.close();assert.equal(age,100);
 }finally{cursor.close();await rm(dir,{recursive:true,force:true});}
});

test('legacy in-flight completion cannot erase a newer retained arrival marker',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'negev-newer-marker-')),file=path.join(dir,'state.sqlite'),old=new DatabaseSync(file);old.exec(await readFile(new URL('./fixtures/file-backfill-schema-v317.sql',import.meta.url),'utf8'));old.exec(`INSERT INTO file_backfill_cursor VALUES(1,0,1,1,'[51]',100,0,NULL,1);INSERT INTO file_backfill_priority VALUES(51,1);INSERT INTO file_backfill_recent_events VALUES(51,1800102,0)`);old.close();const cursor=openFileBackfillCursor(file);
 try{const inventory={listFileHintIds:()=>[]},pending=cursor.claim({inventory,nowMs:103});cursor.record({claim:pending,outcomes:[{fileId:51,state:'available'}],nowMs:104});const newer=cursor.claim({inventory,nowMs:105});assert.deepEqual(newer.fileIds,[51]);const d=new DatabaseSync(file);const observed=d.prepare('SELECT observed_ms FROM file_backfill_arrivals WHERE file_id=51').get()?.observed_ms;d.close();assert.equal(observed,102);
 }finally{cursor.close();await rm(dir,{recursive:true,force:true});}
});
