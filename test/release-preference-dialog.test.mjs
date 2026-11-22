import test from 'node:test';
import assert from 'node:assert/strict';
import {createReleaseDialog} from '../src/web/public/release-dialog.mjs';
test('a preference-only dialog cannot start acquisition while its initial read is pending',async()=>{
 const prior=globalThis.document,nodes=[],calls=[];let reads=0;
 const element=(tag,text,cls)=>{const e={tag,textContent:text,cls,hidden:false,disabled:false,isConnected:true,events:{},classList:{add(){},toggle(){}},append(){},setAttribute(){},showModal(){},replaceChildren(){},addEventListener(name,fn){this.events[name]=fn;}};nodes.push(e);return e;};
 globalThis.document={body:{append(){}},activeElement:null};
 try{
  const api=async(url,opts={})=>{calls.push(opts.body?JSON.parse(opts.body).action:'GET');if(!opts.method){if(++reads===1)return new Promise(()=>{});return{control:{phase:'consumed',mode:'auto',revision:1},context:{confirmedAiring:true}};}throw Error('Captured mutation without performing it');};
  void createReleaseDialog({api,element}).open({requestId:1,title:'Example',preferenceOnly:true});
  await nodes.find(e=>e.textContent==='Auto-Pick').events.click();
  await nodes.find(e=>e.textContent==='Manual Pick').events.click();
  await nodes.find(e=>e.textContent==='Search').events.click();
  assert.deepEqual(calls,['GET']);
  assert.equal(nodes.find(e=>e.cls==='release-mode-actions').hidden,true);
  assert.equal(nodes.find(e=>e.cls==='release-search-actions').hidden,true);
 }finally{if(prior===undefined)delete globalThis.document;else globalThis.document=prior;}
});
