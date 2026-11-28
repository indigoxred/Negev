import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createUserService} from '../src/web/user-service.mjs';

test('real service closes every ledger after one native database close reports failure',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'negev-close-failure-')),databases=new Set();
 const originalPrepare=DatabaseSync.prototype.prepare,originalClose=DatabaseSync.prototype.close;
 let service,reported=false;
 try{
  DatabaseSync.prototype.prepare=function(...args){databases.add(this);return originalPrepare.apply(this,args);};
  service=await createUserService({dbPath:path.join(root,'state.sqlite'),shokoBaseUrl:'http://shoko.invalid:8111',shokoApiKey:'synthetic',sessionKey:randomBytes(32),publicOrigin:'http://localhost:3000',secureCookies:false,fetchImpl:async()=>Response.json({})});
  DatabaseSync.prototype.prepare=originalPrepare;
  DatabaseSync.prototype.close=function(...args){const result=originalClose.apply(this,args);if(!reported){reported=true;throw Error('injected close failure');}return result;};
  await assert.rejects(service.close());
  assert.ok(databases.size>5,'exercise the real service resource graph');
  assert.ok([...databases].every(db=>db.isOpen===false),'every ledger must close despite the first error');
 }finally{
  DatabaseSync.prototype.prepare=originalPrepare;DatabaseSync.prototype.close=originalClose;
  for(const db of databases){try{originalClose.call(db);}catch{}}
  try{await service?.app.close();}catch{}
  await rm(root,{recursive:true,force:true});
 }
});
