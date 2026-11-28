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

test('programmatic preview close completes cleanup before a delayed native close event',async()=>{
 const original=globalThis.document,calls=[],dialogs=[];
 const make=(...args)=>{const node=element(...args);if(args[0]==='dialog'){node.close=()=>{node.open=false;};dialogs.push(node);}return node;};
 globalThis.document={body:element('body'),createElement:make};
 try{
  const picker=createReleaseDialog({element:make,api:async(url,options)=>{calls.push({url,options});throw Error('synthetic unavailable');}});
  await picker.open({previewId:'old-draft',title:'Old'});picker.close();
  assert.equal(calls.filter(c=>c.url==='/api/release-previews/old-draft/close').length,1,'cleanup cannot depend on a later rendering/native-close event');
  await picker.open({previewId:'new-draft',title:'New'});await dialogs[0].emit('close');
  assert.equal(calls.filter(c=>c.url==='/api/release-previews/old-draft/close').length,1,'late event cannot close twice');
  assert.equal(calls.filter(c=>c.url==='/api/release-previews/new-draft/close').length,0,'late old event cannot abandon current draft');
  picker.close();assert.equal(calls.filter(c=>c.url==='/api/release-previews/new-draft/close').length,1);
 }finally{globalThis.document=original;}
});
