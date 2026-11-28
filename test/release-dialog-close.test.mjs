import test from 'node:test';import assert from 'node:assert/strict';
import {element} from './helpers/controller-dom.mjs';import {createReleaseDialog} from '../src/web/public/release-dialog.mjs';
for(const committed of [false,true])test('closing a release dialog releases only an unsaved draft (committed='+committed+')',async()=>{
 const original=globalThis.document,calls=[];globalThis.document={body:element('body'),createElement:element};
 try{
  const dialog=createReleaseDialog({element,api:async(url,options)=>{calls.push({url,options});throw Error('synthetic unavailable')}});
  await dialog.open({previewId:'draft-token',requestId:committed?123:null,title:'Title',existing:committed});
  dialog.close();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.filter(call=>call.url==='/api/release-previews/draft-token/close').length,committed?0:1);
 }finally{globalThis.document=original}
});
