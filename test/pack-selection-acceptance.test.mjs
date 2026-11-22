// Acceptance contracts for bounded completed-season discovery and selection.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequestCandidateDiscovery} from '../src/acquisition/request-candidate-discovery.mjs';
import {createAcquisitionRequestProcessor} from '../src/acquisition/acquisition-request-processor.mjs';
import {matchesReleaseFilters} from '../src/web/public/release-choice-fields.mjs';
const request={id:4,anidbId:42,kind:'series',status:'held',episodeIds:[1001,1002]};
const detail={state:'details',complete:true,total:2,page:1,nextPage:null,anidbId:42,title:'Long Name',kind:'series',restricted:false,airDate:'2020-01-01',endDate:'2020-01-08',episodes:[{id:1001,number:1,type:'Episode',title:'Episode 1',airDate:'2020-01-01'},{id:1002,number:2,type:'Episode',title:'Episode 2',airDate:'2020-01-08'}]};
const candidate=(guid,title)=>({indexerId:1,guid,title,size:2000,seeders:12,evidence:'unverified'});
test('Manual Pick finds a completed pack returned only by a same-ID alias batch query',async()=>{
 const pack=candidate('pack','[Group] Official Alias (01-02) (1080p) [Batch]');
 const discover=createRequestCandidateDiscovery({readRequest:()=>request,loadDetail:async()=>detail,releaseQueries:async()=>['Official Alias'],pause:async()=>{},searchReleases:async({query})=>({state:'candidates',items:query==='Official Alias batch'?[pack]:[]})});
 const found=await discover({requestId:4,interactive:true,filters:{quality:'bd1080',audio:'japanese_dual',packsOnly:true}});
 assert.ok(found.items?.some(x=>x.guid==='pack'),'The alias-only season pack must be visible, not omitted because only the main title receives a batch search');
});
test('Group-name collisions cannot displace an actual same-ID title pack before the automatic cap',async()=>{
 const unrelated=Array.from({length:55},(_,i)=>({...candidate('wrong-'+i,`[Long Name] Unrelated Anime ${i} Season 1 [BD 1080p]`),seeders:100}));
 const pack={...candidate('right','[Group] Official Alias Season 1 [BD 1080p]'),seeders:3};
 const discover=createRequestCandidateDiscovery({readRequest:()=>request,loadDetail:async()=>detail,releaseQueries:async()=>['Official Alias'],pause:async()=>{},searchReleases:async({query})=>({state:'candidates',items:query==='Long Name'?unrelated.slice(0,50):query==='Official Alias'?[...unrelated.slice(50),pack]:[]})});
 const found=await discover({requestId:4});
 assert.equal(found.state,'candidates');assert.ok(found.items.some(x=>x.guid==='right'),'The actual title match was retrieved but lost to unrelated releases whose group happens to share its name');
});
for(const resolution of [480,720])test(`Complete ${resolution}p advertised pack cannot outrank an eligible complete unlabelled 1080p pack`,async()=>{
 const items=[candidate('low',`Long Name (01-02) [Batch] ${resolution}p`),candidate('high','[WEB] Long Name [1080p][HEVC]')];let chosen;
 const process=createAcquisitionRequestProcessor({readRequest:()=>request,requireReleasePolicy:true,preferShokoPreview:true,preferRegisteredCorrespondence:true,discoverCandidates:async()=>({state:'candidates',requestId:4,anidbId:42,releaseState:'completed',items}),previewCandidate:async()=>({state:'preflight',requestId:4,anidbId:42,torrentHash:'a'.repeat(40),episodeIds:[1001,1002],shokoPreview:'exact',correspondence:{files:[{name:'Long Name - 01.mkv',size:1000,state:'likely'},{name:'Long Name - 02.mkv',size:1000,state:'likely'}]},files:[{name:'Long Name - 01.mkv',size:1000,episodeIds:[1001]},{name:'Long Name - 02.mkv',size:1000,episodeIds:[1002]}]}),loadDetail:async()=>detail,submitCandidate:async({candidate})=>{chosen=candidate.guid;return{state:'stopped_observed',attemptId:1};}});
 await process({requestId:4});assert.equal(chosen,'high','An advertised Batch marker is retrieval evidence, not permission to reduce quality');
});
test('Japanese default excludes an explicit parenthesized Chinese-language release annotation',()=>{
 assert.equal(matchesReleaseFilters({title:'[Group] Long Name S1 (Chinese) (1080p HEVC)'},{quality:'bd1080',audio:'japanese_dual'}),false);
});
test('Chinese words in the actual title do not imply incompatible audio',()=>{
 assert.equal(matchesReleaseFilters({title:'[Group] Chinese Paladin (01-12) 1080p'},{quality:'bd1080',audio:'japanese_dual'}),true);
});
test('Default quality retains unlabelled WEB1080 and BD720 packs',()=>{
 for(const title of ['[WEB] Long Name [1080p][HEVC]','[Group] Long Name [BD 720p]'])assert.equal(matchesReleaseFilters({title},{quality:'bd1080',audio:'japanese_dual'}),true,title);
});
test('Older 480p remains an eligible pack fallback when it is the only suitable release',async()=>{
 let submitted=false;const item=candidate('old','Long Name (01-02) [DVD 480p] [Batch]');
 const process=createAcquisitionRequestProcessor({readRequest:()=>request,requireReleasePolicy:true,preferShokoPreview:true,preferRegisteredCorrespondence:true,discoverCandidates:async()=>({state:'candidates',requestId:4,anidbId:42,releaseState:'completed',items:[item]}),previewCandidate:async()=>({state:'preflight',requestId:4,anidbId:42,torrentHash:'a'.repeat(40),episodeIds:[1001,1002],shokoPreview:'exact',correspondence:{files:[{name:'Long Name - 01.mkv',size:1000,state:'likely'},{name:'Long Name - 02.mkv',size:1000,state:'likely'}]},files:[{name:'Long Name - 01.mkv',size:1000,episodeIds:[1001]},{name:'Long Name - 02.mkv',size:1000,episodeIds:[1002]}]}),loadDetail:async()=>detail,submitCandidate:async()=>{submitted=true;return{state:'stopped_observed',attemptId:1};}});
 await process({requestId:4});assert.equal(submitted,true);
});




test('language annotations exclude non-Japanese audio without treating a group name as a language',()=>{
 const filters={quality:'bd1080',audio:'japanese_dual'};
 for(const tag of ['(Chinese)','[Chinese]','(Russian)','[French]'])assert.equal(matchesReleaseFilters({title:`[Group] Long Name ${tag} 1080p`},filters),false,tag);
 assert.equal(matchesReleaseFilters({title:'[Chinese] Long Name 1080p'},filters),true);
 assert.equal(matchesReleaseFilters({title:'[Group] Long Name (Chinese) Japanese Audio 1080p'},filters),true);
});

test('suffix group-name collisions cannot evict the requested show before the automatic cap',async()=>{
 const unrelated=Array.from({length:55},(_,i)=>({...candidate('suffix-'+i,`Unrelated Anime ${i} Season 1 BD 1080p-LongName`),seeders:100}));
 const pack={...candidate('right','[Group] Official Alias Season 1 [BD 1080p]'),seeders:3};
 const suffixDetail={...detail,title:'LongName'};
 const discover=createRequestCandidateDiscovery({readRequest:()=>request,loadDetail:async()=>suffixDetail,releaseQueries:async()=>['Official Alias'],pause:async()=>{},searchReleases:async({query})=>({state:'candidates',items:query==='LongName'?unrelated.slice(0,50):query==='Official Alias'?[...unrelated.slice(50),pack]:[]})});
 const found=await discover({requestId:4});assert.equal(found.state,'candidates');assert.ok(found.items.some(x=>x.guid==='right'));
});

test('a bare origin/language annotation is not foreign-audio-only when dual audio is advertised',()=>{
 const filters={quality:'bd1080',audio:'japanese_dual'};
 assert.equal(matchesReleaseFilters({title:'[Group] Long Name (Chinese) Dual Audio 1080p'},filters),true);
 assert.equal(matchesReleaseFilters({title:'[Group] Long Name Chinese Audio Dual Audio 1080p'},filters),false);
});
