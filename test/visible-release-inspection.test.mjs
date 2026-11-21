import test from 'node:test';import assert from 'node:assert/strict';
import {createVisibleReleaseInspectionQueue} from '../src/web/public/release-row.mjs';
const tick=()=>new Promise(r=>setImmediate(r));
function fixture(){let callback,observer;class Observer{constructor(cb){callback=cb;observer=this;this.nodes=new Set();}observe(n){this.nodes.add(n);}unobserve(n){this.nodes.delete(n);}disconnect(){this.nodes.clear();}}
const q=createVisibleReleaseInspectionQueue({root:{},Observer,waitForTurn:async()=>true});return{q,visible:n=>callback([{target:n,isIntersecting:true}]),hidden:n=>callback([{target:n,isIntersecting:false}]),nodes:()=>observer.nodes};}
test('visible release inspections are serial, once per row and never start for hidden rows',async()=>{
 const f=fixture(),a={},b={},hidden={};let calls=[],release;
 f.q.observe(a,()=>new Promise(resolve=>{calls.push('a');release=resolve;}));f.q.observe(b,async()=>calls.push('b'));f.q.observe(hidden,async()=>calls.push('hidden'));
 f.hidden(hidden);f.visible(a);f.visible(a);f.visible(b);await tick();assert.deepEqual(calls,['a']);release();await tick();assert.deepEqual(calls,['a','b']);assert.equal(f.nodes().has(hidden),true);f.q.clear();
});
test('clearing queued evidence cancels old rows but lets a new visible search run after the in-flight read',async()=>{
 const f=fixture(),a={},b={},c={};let calls=[],release;
 f.q.observe(a,()=>new Promise(resolve=>{calls.push('a');release=resolve;}));f.q.observe(b,async()=>calls.push('old'));f.visible(a);f.visible(b);await tick();f.q.clear();f.q.observe(c,async()=>calls.push('new'));f.visible(c);release();await tick();assert.deepEqual(calls,['a','new']);f.q.clear();
});
test('a failed background inspection is not retried and does not stop the next visible result',async()=>{
 const f=fixture(),a={},b={};let calls=[];f.q.observe(a,async()=>{calls.push('failed');throw Error('provider unavailable');});f.q.observe(b,async()=>calls.push('next'));f.visible(a);f.visible(b);await tick();f.visible(a);await tick();assert.deepEqual(calls,['failed','next']);f.q.clear();
});

test('a queued row scrolled out of view waits until it becomes visible again',async()=>{
 const f=fixture(),a={},b={};let calls=[],release;
 f.q.observe(a,()=>new Promise(r=>{calls.push('a');release=r;}));f.q.observe(b,async()=>calls.push('b'));
 f.visible(a);f.visible(b);await tick();f.hidden(b);release();await tick();assert.deepEqual(calls,['a']);f.visible(b);await tick();assert.deepEqual(calls,['a','b']);f.q.clear();
});
