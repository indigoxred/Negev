import test from'node:test';
import assert from'node:assert/strict';
import {createRequestCandidateDiscovery}from'../src/acquisition/request-candidate-discovery.mjs';
const candidate=(guid,title,seeders=20)=>({guid,title,indexerId:1,size:1000,seeders,evidence:'unverified'});
const single=i=>candidate('single-'+i,'Example Season 1 S01E'+String(i+1).padStart(2,'0')+' [WEB1080p]'.replace('WEB1080','WEB 1080'),300-i);
const pack=i=>candidate('pack-'+i,'[Group'+i+'] Example Season 1 Batch [BD 1080p]',20);
function fixture({state='completed',kind='series',items,aliases=[],byQuery}={}){
 const request={id:1,status:'held',anidbId:42,kind,episodeIds:[101,102]};
 const detail={state:'details',anidbId:42,page:1,total:2,complete:true,nextPage:null,title:'Example',kind,restricted:false,
  airDate:'2020-01-01',endDate:state==='completed'?'2020-03-01':state==='airing'?'2027-03-01':null,episodeCount:2,
  episodes:[{id:101,type:'Episode',number:1,title:'First',airDate:'2020-01-01'},{id:102,type:'Episode',number:2,title:'Second',airDate:'2020-01-08'}]};
 return createRequestCandidateDiscovery({readRequest:()=>request,loadDetail:async()=>detail,releaseQueries:async()=>aliases,
  now:()=>Date.UTC(2026,10,21),pause:async()=>{},searchReleases:async({query})=>({state:'candidates',items:byQuery?byQuery(query):items})});
}
const filters={quality:'bd1080',audio:'japanese'};

test('completed Manual Pick hides advertised singles by default but retains unlabelled BD packs',async()=>{
 const unknown=candidate('unknown','Example [BD]');const discover=fixture({items:[...Array.from({length:80},(_,i)=>single(i)),pack(1),unknown]});
 const result=await discover({requestId:1,interactive:true,filters});
 assert.deepEqual(result.items.map(x=>x.guid),['pack-1','unknown']);assert.equal(result.filteredOut,80);assert.equal(result.nextOffset,null);
});

test('completed pack filtering happens before pagination and can be switched off',async()=>{
 const discover=fixture({items:[...Array.from({length:90},(_,i)=>single(i)),...Array.from({length:60},(_,i)=>pack(i))]});
 const first=await discover({requestId:1,interactive:true,filters:{...filters,packsOnly:true}});
 const second=await discover({requestId:1,interactive:true,resultOffset:50,filters:{...filters,packsOnly:true}});
 assert.equal(first.items.length,50);assert.equal(first.nextOffset,50);assert.equal(second.items.length,10);assert.equal(second.nextOffset,null);
 assert.equal(new Set([...first.items,...second.items].map(x=>x.guid)).size,60);
 assert.ok([...first.items,...second.items].every(x=>x.guid.startsWith('pack-')));
 const shown=await discover({requestId:1,interactive:true,filters:{...filters,packsOnly:false}});
 assert.ok(shown.items.every(x=>x.guid.startsWith('pack-')));
 const tail=await discover({requestId:1,interactive:true,resultOffset:100,filters:{...filters,packsOnly:false}});
 assert.ok(tail.items.some(x=>x.guid.startsWith('single-')));
});

test('a later query pack is ranked before the combined200candidate cap',async()=>{
 const discover=fixture({aliases:['Official Example'],byQuery:query=>query==='Example'?Array.from({length:200},(_,i)=>single(i)):[pack(99)]});
 const result=await discover({requestId:1,interactive:true,filters:{...filters,packsOnly:false}});
 assert.equal(result.items[0].guid,'pack-99');
});

for(const input of [{state:'airing'},{state:'completed',kind:'movie'}]){
 test('pack-only controls do not change '+JSON.stringify(input)+' searches',async()=>{
  const items=[single(1),pack(1)];const discover=fixture({...input,items});
  const result=await discover({requestId:1,interactive:true,filters:{...filters,packsOnly:true}});
  assert.deepEqual(result.items.map(x=>x.guid),items.map(x=>x.guid));
 });
}
test('pack filter rejects unvalidated string values',async()=>{
 const result=await fixture({items:[pack(1)]})({requestId:1,interactive:true,filters:{...filters,packsOnly:'yes'}});
 assert.equal(result.reason,'invalid_release_filters');
});

test('manual UHD eligibility is applied before packs are ranked and capped',async()=>{
 const uhd=candidate('uhd','[Group] Example Season 1 Batch BD 2160p');
 const discover=fixture({aliases:['Official Example'],byQuery:query=>query==='Example'?Array.from({length:200},(_,i)=>single(i)):[uhd]});
 const result=await discover({requestId:1,interactive:true,filters:{...filters,quality:'1080',packsOnly:false}});
 assert.equal(result.items[0].guid,'uhd');assert.equal(result.items[0].selectionPolicy.allowUhd,true);
});
