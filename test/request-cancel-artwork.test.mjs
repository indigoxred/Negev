import test from 'node:test';import assert from 'node:assert/strict';import {element,descendants} from './helpers/controller-dom.mjs';import {createResponseEpoch} from '../src/web/public/response-epoch.mjs';import {createRequestController} from '../src/web/public/request-controller.mjs';
for(const confirmed of [false,true])test('preparation cancellation is deliberate and uses the exact request (confirmed='+confirmed+')',async()=>{
 const nodes=new Map(),byId=id=>{if(!nodes.has(id))nodes.set(id,element());return nodes.get(id)},calls=[],messages=[];let asked=0;
 const controller=createRequestController({byId,element,state:{user:{id:7},nextBeforeId:{},requestHistoryExpanded:true},sessionResponses:createResponseEpoch(),requestResponses:{preparing:createResponseEpoch(),history:createResponseEpoch(),watching:createResponseEpoch()},restoreRoutePosition(){},posterImage:()=>element('img'),titleLabel:item=>element('span',item.title),message:value=>messages.push(value),window:{confirm:()=>{asked++;return confirmed}},api:async(url,options)=>{calls.push({url,options});if(options?.method==='POST')return{state:'cancelled'};return{items:url.startsWith('/api/request-preparations')?[{id:12,anidbId:42,title:'Title',state:'pending'}]:[],nextBeforeId:null}}});
 await controller.loadPreparations();const cancel=descendants(byId('preparing-list')).find(n=>n.tag==='button'&&n.textContent==='Cancel request');await cancel.click();
 assert.equal(asked,1);assert.deepEqual(calls.filter(c=>c.options?.method==='POST').map(c=>c.url),confirmed?['/api/request-preparations/12/cancel']:[]);
});
test('request list artwork has a visible fallback frame instead of an unlabelled gap',async()=>{
 const nodes=new Map(),byId=id=>{if(!nodes.has(id))nodes.set(id,element());return nodes.get(id)};
 const controller=createRequestController({byId,element,state:{user:{id:7},nextBeforeId:{}},sessionResponses:createResponseEpoch(),requestResponses:{preparing:createResponseEpoch()},posterImage:()=>element('img','','missing-art'),titleLabel:item=>element('span',item.title),api:async()=>({items:[{id:12,anidbId:42,title:'Title',state:'pending'}],nextBeforeId:null})});
 await controller.loadPreparations();const frame=byId('preparing-list').querySelector('.request-art');assert.ok(frame);assert.equal(frame.classList.contains('poster-frame'),true);assert.ok(frame.querySelector('img').classList.contains('missing-art'));
});

for(const confirmed of [false,true])test('saved request cancellation asks before sending (confirmed='+confirmed+')',async()=>{
 const nodes=new Map(),byId=id=>{if(!nodes.has(id))nodes.set(id,element());return nodes.get(id)},calls=[];let asked=0;
 const item={id:12,anidbId:42,title:'Title',status:'held',canCancel:true,requesterId:7,kind:'series',monitorFuture:false,episodeIds:[1],progress:{state:'saved',targetCount:1,publicAvailability:'unverified'}};
 const controller=createRequestController({byId,element,state:{user:{id:7,role:'member'},requestScope:'mine',nextBeforeId:{}},sessionResponses:createResponseEpoch(),requestResponses:{preparing:createResponseEpoch(),history:createResponseEpoch(),watching:createResponseEpoch()},restoreRoutePosition(){},posterImage:()=>element('img'),titleLabel:item=>element('span',item.title),message(){},window:{confirm:()=>{asked++;return confirmed}},api:async(url,options)=>{calls.push({url,options});return options?.method==='POST'?{state:'cancelled'}:{items:url.startsWith('/api/requests?')?[item]:[],nextBeforeId:null}}});
 await controller.loadRequestView('history');const cancel=descendants(byId('request-list')).find(n=>n.tag==='button'&&n.textContent==='Cancel request');assert.ok(cancel);await cancel.click();
 assert.equal(asked,1);assert.deepEqual(calls.filter(c=>c.options?.method==='POST').map(c=>c.url),confirmed?['/api/requests/12/cancel']:[]);
});
