import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {openAvailabilityScope} from '../src/availability/availability-scope.mjs';
import {openFileProofLedger} from '../src/availability/file-proof-ledger.mjs';
test('scope reconciliation preserves the original error after SQLite rolls its transaction back',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'scope-original-error-'));const dbPath=path.join(root,'state.sqlite');const proofs=openFileProofLedger(dbPath,{positiveLifetimeMs:1000,now:()=>100});
 const db=new DatabaseSync(dbPath),scope=openAvailabilityScope(dbPath);
 try{
  proofs.observe({anidbId:42,episodeId:1001,proof:{fileId:7,libraryId:102,ratingKey:500,partId:600},checkedMs:99});
  db.exec("CREATE TRIGGER reject_scope_delete BEFORE DELETE ON file_availability_proofs BEGIN SELECT RAISE(ROLLBACK,'source invariant'); END");
  assert.throws(()=>scope.reconcile({serverIdentity:'synthetic-server',episodeLibraryIds:[102],movieLibraryIds:[],shokoMount:{appRoot:'/pure',localRoot:root},plexMounts:[{appRoot:'/plex',localRoot:root}],observedMs:100}),/source invariant/);
  assert.equal(proofs.getCurrent({anidbId:42,episodeId:1001}).state,'available');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM availability_scope').get().n,0);
 }finally{scope.close();db.close();proofs.close();await rm(root,{recursive:true,force:true});}
});
