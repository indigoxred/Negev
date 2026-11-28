import test from 'node:test';
import assert from 'node:assert/strict';
import {element,descendants} from './helpers/controller-dom.mjs';
import {createResponseEpoch} from '../src/web/public/response-epoch.mjs';
import {createRequestController} from '../src/web/public/request-controller.mjs';
import {createSeriesRequestController} from '../src/web/public/series-request-controller.mjs';

test('paused preparation renders an administrator resolution instead of an episode-list wait',async()=>{
 const nodes=new Map(),byId=id=>{if(!nodes.has(id))nodes.set(id,element());return nodes.get(id)};
 const controller=createRequestController({byId,element,state:{user:{id:7},nextBeforeId:{}},sessionResponses:createResponseEpoch(),requestResponses:{preparing:createResponseEpoch()},
  api:async()=>({items:[{id:1,anidbId:42,title:'Title',state:'pending',reason:'watch_paused_elsewhere'}],nextBeforeId:null}),posterImage:()=>element('img'),titleLabel:item=>element('span',item.title)});
 await controller.loadPreparations();assert.match(byId('preparing-list').textContent,/paused.*administrator/i);
 assert.doesNotMatch(byId('preparing-list').textContent,/Waiting for a verified episode list/);
});

test('multi-season paused response remains an actionable message rather than a raw reason',async()=>{
 const panel=element(),heading=element('h2'),data={state:'details',kind:'series',anidbId:42,regularSeason:{total:1,verified:0},episodes:[],nextPage:null};panel.append(heading);
 const view={data,pager:{episodes:[],nextPage:null},item:{anidbId:42,title:'Title'},panel,relatedHeading:heading,element,document:{createElement:element},state:{user:{id:7},releaseSearch:false},
  detailActionRow:(...nodes)=>{const row=element();row.append(...nodes);return row},family:{items:()=>[{anidbId:42,title:'Title'}],next:()=>null},relatedDetails:{peek:()=>null},
  isCurrentDetail:()=>true,preferredDisplayTitle:item=>item.title,titleLabel:item=>element('span',item.title),requestKeys:{pending:()=> 'key',rejected(){},saved(){}},sessionResponses:createResponseEpoch(),
  api:async()=>({items:[{anidbId:42,status:409,result:{state:'held',reason:'watch_paused_elsewhere'}}]})};
 createSeriesRequestController(view);
 const all=()=>descendants(panel),trigger=all().find(n=>n.classList.contains('season-request-trigger'));
 await trigger.click();const input=all().find(n=>n.tag==='input');input.checked=true;await input.emit('change');
 const submit=all().find(n=>n.tag==='button'&&n.textContent==='Request season');assert.ok(submit,'request confirmation button');
 await submit.click();await submit.click();
 assert.match(panel.textContent,/paused.*administrator/i);assert.doesNotMatch(panel.textContent,/watch_paused_elsewhere/);
});
