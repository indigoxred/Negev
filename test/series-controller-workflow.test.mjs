import test from 'node:test';import assert from 'node:assert/strict';
import {seriesFixture,details,settle} from './helpers/series-controller-fixture.mjs';

test('watched root keeps a retry reachable after a sibling detail failure',async()=>{
 const x=seriesFixture({entries:[42,43],data:details(42,{futureEpisodesMonitored:true}),get:async()=>({state:'detail_unavailable'})});await settle();
 assert.equal(x.find('.season-request-trigger').hidden,false);assert.equal(x.find('.season-request-trigger').disabled,false);
 await x.find('.season-request-trigger').click();await settle();assert.ok(x.reads.length>=2);
});
test('watched root can reach a ninth installment beyond the initial inspection budget',async()=>{
 const cache=new Map(Array.from({length:7},(_,i)=>[43+i,details(43+i,{regularSeason:{total:1,verified:1}})]));
 const x=seriesFixture({entries:Array.from({length:9},(_,i)=>42+i),cache,data:details(42,{futureEpisodesMonitored:true})});await settle();
 assert.equal(x.find('.season-request-trigger').hidden,false);assert.equal(x.find('.season-request-trigger').disabled,false);
 await x.find('.season-request-trigger').click();await settle();assert.ok(x.reads.includes(50));
});
test('a newly populated sibling detail cache updates existing chooser rows',async()=>{
 const x=seriesFixture({entries:[42,43],data:details(42,{futureEpisodesMonitored:true}),get:async()=>({state:'detail_unavailable'})});await settle();
 x.cache.set(43,details(43));x.view.syncSeasonRows();
 const row=x.all().find(n=>n.dataset.anidbId==='43');assert.equal(row.querySelector('input').disabled,false);
});
test('mixed Auto review retains earlier successful requests across a retry exactly once',async()=>{
 let turn=0;const x=seriesFixture({entries:[42,43],releaseSearch:true,api:async()=>({items:++turn===1?[{anidbId:42,status:202,result:{requestId:1,targetIds:[1],created:true}},{anidbId:43,status:503,result:{reason:'detail_unavailable'}}]:[{anidbId:43,status:202,result:{requestId:2,targetIds:[2],created:true}}]})});
 await settle();await x.selectAll();await x.button('Auto-Pick').click();await settle();assert.equal(x.opened.length,0);
 await x.button('Auto-Pick').click();await settle();assert.deepEqual(x.opened[0]?.jobs.map(j=>j.requestId),[1,2]);
});
test('a stale Manual click explains lost capability without closing the chooser',async()=>{
 const x=seriesFixture({releaseSearch:true});await x.selectAll();assert.equal(x.find('dialog').open,true);
 x.view.state.releaseSearch=false;await x.button('Manual Pick').click();await settle();
 assert.equal(x.find('dialog').open,true);assert.match(x.panel.textContent,/release search.*unavailable/i);assert.equal(x.opened.length,0);
});
test('an open chooser gains and loses current release actions',async()=>{
 const x=seriesFixture();await x.selectAll();x.view.state.releaseSearch=true;x.controller.refreshCapabilities();
 assert.equal(x.button('Manual Pick').hidden,false);assert.equal(x.button('Manual Pick').disabled,false);
 x.view.state.releaseSearch=false;x.controller.refreshCapabilities();assert.equal(x.button('Manual Pick').hidden,true);
});

test('explicit automatic confirmation recovers from a previous Manual choice after capability loss',async()=>{
 let calls=0;const x=seriesFixture({releaseSearch:true,api:async()=>{calls++;return{items:[{anidbId:42,status:202,result:{requestId:1,created:true,targetIds:[1]}}]}}});
 await x.selectAll();await x.button('Manual Pick').click();await settle();
 x.view.state.releaseSearch=false;x.controller.refreshCapabilities();await x.find('.season-request-trigger').click();
 const submit=x.button('Request season');await submit.click();await submit.click();await settle();assert.equal(calls,1);
});
for(const requestedReview of [false,true])test('review intent follows the submitted action across a capability flip (review='+requestedReview+')',async()=>{
 const gate=Promise.withResolvers();let sent;
 const x=seriesFixture({releaseSearch:requestedReview,api:async(url,options)=>{sent=JSON.parse(options.body);return gate.promise}});await x.selectAll();
 if(requestedReview)await x.button('Auto-Pick').click();else{const submit=x.button('Request season');await submit.click();void submit.click();}
 await settle();x.view.state.releaseSearch=!requestedReview;x.controller.refreshCapabilities();gate.resolve({items:[{anidbId:42,status:202,result:{requestId:1,targetIds:[1],created:true}}]});await settle();
 assert.equal(sent.seasons[0].releaseMode,requestedReview?'auto_review':undefined);assert.equal(x.opened.length,0);
 if(requestedReview){x.view.state.releaseSearch=true;x.controller.refreshCapabilities();const review=x.button('Review saved requests');assert.ok(review&&!review.hidden&&!review.disabled);await review.click();assert.deepEqual(x.opened[0].jobs.map(j=>j.requestId),[1]);await x.controller.refreshCapabilities();assert.equal(x.opened.length,1);}
});
