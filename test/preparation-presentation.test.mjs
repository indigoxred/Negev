import test from 'node:test';import assert from 'node:assert/strict';import {element} from './helpers/controller-dom.mjs';import {createResponseEpoch} from '../src/web/public/response-epoch.mjs';import {createRequestController} from '../src/web/public/request-controller.mjs';
for(const [reason,text] of [['already_available',/Already available/],['already_monitored_elsewhere',/Future episodes are already monitored/]])test('settled preparation heading and body agree for '+reason,async()=>{
 const nodes=new Map(),byId=id=>{if(!nodes.has(id))nodes.set(id,element());return nodes.get(id)};
 const controller=createRequestController({byId,element,state:{user:{id:7},nextBeforeId:{}},sessionResponses:createResponseEpoch(),requestResponses:{preparing:createResponseEpoch()},posterImage:()=>element('img'),titleLabel:item=>element('span',item.title),api:async()=>({items:[{id:1,anidbId:42,title:'Title',state:'complete',reason}],nextBeforeId:null})});
 await controller.loadPreparations();const output=byId('preparing-list').textContent;assert.match(output,text);assert.doesNotMatch(output,/Preparing episode details|could not be requested automatically/);
});
