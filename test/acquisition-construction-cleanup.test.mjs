import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {stoppedPack} from './helpers/stopped-pack.mjs';
import {openAcquisitionRuntime} from '../src/acquisition/acquisition-runtime.mjs';
import {openAcquisitionPipeline} from '../src/acquisition/acquisition-pipeline.mjs';
import {openHandoffLedger} from '../src/acquisition/handoff-ledger.mjs';

for(const closeFails of [false,true])test(`runtime constructor closes its quality ledger after stage failure (closeFails=${closeFails})`,async t=>{
 const x=await stoppedPack(t),opened=new Set(),exec=DatabaseSync.prototype.exec,close=DatabaseSync.prototype.close;
 try{
  DatabaseSync.prototype.exec=function(...args){opened.add(this);return exec.apply(this,args);};
  if(closeFails)DatabaseSync.prototype.close=function(...args){close.apply(this,args);throw Error('injected quality close failure');};
  assert.throws(()=>openAcquisitionRuntime({enabled:true,dbPath:x.dbPath,acquisitions:x.ledger}),error=>closeFails?error instanceof AggregateError:true);
  assert.ok(opened.size>0);assert.ok([...opened].every(db=>!db.isOpen),'quality inspection handle must not leak');
 }finally{DatabaseSync.prototype.exec=exec;DatabaseSync.prototype.close=close;for(const db of opened){try{close.call(db);}catch{}}}
});

test('pipeline construction preserves the open failure and closes later handles after an unwind failure',async t=>{
 const x=await stoppedPack(t),handoffs=openHandoffLedger(x.dbPath);handoffs.close();
 const opened=new Set(),exec=DatabaseSync.prototype.exec,close=DatabaseSync.prototype.close;let closes=0,caught;
 try{
  DatabaseSync.prototype.exec=function(sql,...args){opened.add(this);if(sql.includes('CREATE TABLE IF NOT EXISTS handoff_publish_checks'))throw Error('injected queue open failure');return exec.call(this,sql,...args);};
  DatabaseSync.prototype.close=function(...args){close.apply(this,args);if(++closes===2)throw Error('injected partial close failure');};
  try{openAcquisitionPipeline({dbPath:x.dbPath,acquisitions:x.ledger,qbBaseUrl:'http://qbit.invalid/',sessionGate:{get:async()=>({state:'authenticated',sessionId:'synthetic'}),invalidate(){}},processRequest:async()=>{},processStart:async()=>{},processCompletion:async()=>{},processPublish:async()=>{}});}catch(error){caught=error;}
  assert.ok(caught instanceof AggregateError,String(caught?.stack));assert.match(caught.errors[0].message,/injected queue open failure/);
  assert.ok([...opened].every(db=>!db.isOpen),'all partially constructed queue handles must close');
 }finally{DatabaseSync.prototype.exec=exec;DatabaseSync.prototype.close=close;for(const db of opened){try{close.call(db);}catch{}}}
});
