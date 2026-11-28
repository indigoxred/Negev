import test from 'node:test';import assert from 'node:assert/strict';
import {element} from './helpers/controller-dom.mjs';import {createResponseEpoch} from '../src/web/public/response-epoch.mjs';
import {createTrackingController} from '../src/web/public/tracking-controller.mjs';
import {createViewHelpers} from '../src/web/public/view-helpers.mjs';
for(const cold of [true,false])test('tracked title retains Chinese visibility and preferred English title (cold='+cold+')',async()=>{
 const known={anidbId:42,title:'Original',englishTitle:'English',adult:false,chineseProduction:true},state={user:{id:7},preferEnglish:true,showChinese:false,searchItems:new Map(cold?[]:[[42,known]]),airingPreferences:{mode:'custom',trackedAnidbIds:[42]}};
 const nodes=new Map(),byId=id=>{if(!nodes.has(id))nodes.set(id,element());return nodes.get(id)};byId('tracked-titles').open=true;
 const document={createElement:element,querySelectorAll:selector=>byId('tracked-titles-list').querySelectorAll(selector)},helpers=createViewHelpers({state,byId,document});
 const markAdult=(row,item)=>{row.dataset.chineseProduction=String(item.chineseProduction===true);row.hidden=item.chineseProduction===true;return row};
 const controller=createTrackingController({state,byId,element,document,sessionResponses:createResponseEpoch(),api:async()=>({state:'display',...known,restricted:false}),markAdult,titleLabel:helpers.titleLabel,preferredDisplayTitle:helpers.preferredDisplayTitle,
  applyAdultVisibility:()=>{for(const row of byId('tracked-titles-list').children)markAdult(row,state.searchItems.get(42))}});
 controller.renderTrackedTitles();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(state.searchItems.get(42).chineseProduction,true);assert.equal(state.searchItems.get(42).englishTitle,'English');
 assert.equal(byId('tracked-titles-list').children[0].hidden,true);assert.match(byId('tracked-titles-list').querySelector('a').textContent,/English/);
});
