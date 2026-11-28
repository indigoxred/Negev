import test from 'node:test';import assert from 'node:assert/strict';
import {element,descendants} from './helpers/controller-dom.mjs';
import {createInstallmentRequestControls} from '../src/web/public/detail-installment-request.mjs';

test('open film controls gain release search and keep a stale manual action recoverable',async()=>{
 const panel=element(),heading=element('h2'),state={user:{id:7},releaseSearch:false};panel.append(heading);
 let previews=0;const view={element,panel,relatedHeading:heading,state,data:{kind:'movie',title:'Film',anidbId:42},item:{anidbId:42,title:'Film'},pager:{episodes:[{id:88,type:'Episode',availability:'unknown'}],nextPage:null},
  related:{selectedInstallmentId:42,selectedAvailability:'unknown'},family:{items:()=>[]},detailActionRow:(...items)=>{const row=element();row.append(...items);return row},
  isCurrentDetail:()=>true,openPreviewReleaseRequests:async()=>previews++,requestKeys:{pending:()=> 'key'}};
 const controls=createInstallmentRequestControls(view);
 state.releaseSearch=true;controls.refreshCapabilities();
 const button=label=>descendants(panel).find(n=>n.tag==='button'&&n.textContent===label);
 await button('Request film').click();const dialog=panel.querySelector('dialog');assert.equal(dialog.open,true);
 state.releaseSearch=false;await button('Manual Pick').click();assert.equal(dialog.open,true);assert.equal(previews,0);
 assert.match(panel.textContent,/release search.*unavailable/i);
});

function filmFixture({releaseSearch=false,entries=[88],api}={}){
 const panel=element(),heading=element('h2'),state={user:{id:7},releaseSearch};panel.append(heading);const opened=[];
 const view={element,panel,relatedHeading:heading,state,data:{kind:'movie',title:'Film',anidbId:42},item:{anidbId:42,title:'Film'},pager:{episodes:entries.map((id,i)=>({id,number:i+1,type:'Episode',availability:'unknown'})),nextPage:null},
  related:{selectedInstallmentId:42,selectedAvailability:'unknown'},family:{items:()=>[]},detailActionRow:(...items)=>{const row=element();row.append(...items);return row},
  isCurrentDetail:()=>true,openPreviewReleaseRequests:async()=>{},requestKeys:{pending:()=> 'key',saved(){}},api:api??(async()=>({state:'held',requestId:1,created:true})),message(){},currentAcquisitionNotice:()=>'',refreshTrackingAfterRequest(){},loadRequests(){},openSavedReleaseRequests:(jobs,mode)=>opened.push({jobs,mode})};
 const controls=createInstallmentRequestControls(view),button=label=>descendants(panel).find(n=>n.tag==='button'&&n.textContent===label);
 return {panel,state,view,controls,button,opened};
}
const settled=()=>new Promise(resolve=>setImmediate(resolve));
test('film entry selection stays reachable without release search and saves the chosen episode',async()=>{
 let sent;const x=filmFixture({entries:[88,99],api:async(url,options)=>{sent=JSON.parse(options.body);return{state:'held',requestId:1,created:true}}});
 await x.button('Request film').click();assert.equal(x.panel.querySelector('dialog').open,true);
 x.view.filmChoiceSelect.value='99';await x.view.filmChoiceSelect.emit('change');await x.button('Save automatic request').click();await settled();
 assert.deepEqual(sent.episodeIds,[99]);assert.equal(sent.scope,'episodes');
});
test('film explicit automatic confirmation can follow a previous Manual choice',async()=>{
 let saves=0;const x=filmFixture({releaseSearch:true,api:async()=>{saves++;return{state:'held',requestId:1,created:true}}});
 await x.button('Request film').click();await x.button('Manual Pick').click();await settled();
 x.state.releaseSearch=false;x.controls.refreshCapabilities();const button=x.button('Request film');await button.click();await button.click();await settled();assert.equal(saves,1);
});
for(const review of [false,true])test('film review intent survives capability changes (review='+review+')',async()=>{
 const gate=Promise.withResolvers();let sent;const x=filmFixture({releaseSearch:review,api:async(url,options)=>{sent=JSON.parse(options.body);return gate.promise}});
 await x.button('Request film').click();if(review)await x.button('Auto-Pick').click();else void x.button('Confirm request').click();await settled();
 x.state.releaseSearch=!review;x.controls.refreshCapabilities();gate.resolve({state:'held',requestId:1,created:true});await settled();
 assert.equal(sent.releaseMode,review?'auto_review':undefined);assert.equal(x.opened.length,0);
 if(review){x.state.releaseSearch=true;x.controls.refreshCapabilities();const button=x.button('Review saved request');assert.ok(button&&!button.hidden);await button.click();assert.equal(x.opened.length,1);}
});
