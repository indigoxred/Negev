import {element,descendants} from './controller-dom.mjs';
import {createResponseEpoch} from '../../src/web/public/response-epoch.mjs';
import {createSeriesRequestController} from '../../src/web/public/series-request-controller.mjs';
import {makeReleaseActions} from '../../src/web/public/release-dialog.mjs';
export const details=(id,extra={})=>({state:'details',kind:'series',anidbId:id,title:'Title '+id,regularSeason:{total:1,verified:0},episodes:[],nextPage:null,...extra});
export const settle=()=>new Promise(resolve=>setImmediate(resolve));
export function seriesFixture({entries=[42],data=details(42),cache=new Map(),get,api,releaseSearch=false}={}){
 const panel=element(),heading=element('h2');panel.append(heading);const opened=[],reads=[];
 const view={data,pager:{episodes:[],nextPage:null},item:{anidbId:42,title:'Title 42'},panel,relatedHeading:heading,element,document:{createElement:element},state:{user:{id:7},releaseSearch},
  detailActionRow:(...nodes)=>{const row=element();row.append(...nodes);return row},family:{items:()=>entries.map(anidbId=>({anidbId,title:'Title '+anidbId})),next:()=>null},
  relatedDetails:{peek:id=>cache.get(id),get:async id=>{reads.push(id);return get?get(id):cache.get(id)??details(id)}},
  isCurrentDetail:()=>true,preferredDisplayTitle:item=>item.title,titleLabel:item=>element('span',item.title),requestKeys:{pending:()=> 'key',rejected(){},saved(){}},sessionResponses:createResponseEpoch(),makeReleaseActions,
  api:api??(async()=>({items:[]})),refreshTrackingAfterRequest(){},loadRequests(){},openSavedReleaseRequests:(jobs,mode)=>opened.push({jobs,mode}),openPreviewReleaseRequests:async jobs=>opened.push({jobs,mode:'manual'})};
 const controller=createSeriesRequestController(view),all=()=>descendants(panel),find=selector=>panel.querySelector(selector),button=text=>all().find(n=>n.tag==='button'&&n.textContent===text);
 return {view,controller,panel,all,find,button,cache,reads,opened,async selectAll(){await find('.season-request-trigger').click();await settle();for(const input of all().filter(n=>n.tag==='input'&&!n.disabled))input.checked=true;await all().find(n=>n.tag==='input').emit('change');}};
}
