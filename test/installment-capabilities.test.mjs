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
