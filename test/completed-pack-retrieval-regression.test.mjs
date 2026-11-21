import test from 'node:test';
import assert from 'node:assert/strict';
import {parseAniDbTitleDump} from '../src/catalogue/anidb-title-index.mjs';
import {createRequestCandidateDiscovery} from '../src/acquisition/request-candidate-discovery.mjs';
import {isPackBonusVideo} from '../src/acquisition/pack-bonus-name.mjs';
import * as queries from '../src/acquisition/trusted-release-queries.mjs';

test('descriptive English synonyms join bounded same-ID retrieval without short acronyms',()=>{
 const index=parseAniDbTitleDump('10|1|x-zht|Long Zu\n10|4|en|Dragon Raja: The Blazing Dawn\n10|2|en|Dragon Raja\n10|3|en|DR\n11|1|x-jat|Boku no Hero Academia\n11|2|en|My Hero Academia\n11|2|en|MHA\n');
 assert.deepEqual(index.get(10).releaseQueries,['Long Zu','Dragon Raja: The Blazing Dawn','Dragon Raja']);
 assert.deepEqual(index.get(11).releaseQueries,['Boku no Hero Academia','My Hero Academia']);
});
test('completed automatic discovery retrieves bounded pack buckets before episode pages',async()=>{
 const calls=[];const request={id:1,anidbId:10,kind:'series',status:'held',episodeIds:[101,102]};
 const detail={state:'details',anidbId:10,title:'Canonical Title',kind:'series',restricted:false,page:1,total:2,complete:true,nextPage:null,airDate:'2020-01-01',endDate:'2020-01-08',episodes:[1,2].map(n=>({id:100+n,number:n,type:'Episode',title:`Episode ${n}`,airDate:'2020-01-01'}))};
 const discover=createRequestCandidateDiscovery({readRequest:()=>request,loadDetail:async()=>detail,releaseQueries:async()=>['Official Alias'],pause:async()=>{},searchReleases:async x=>{calls.push(x);return {state:'candidates',items:x.query.endsWith(' batch')?[{indexerId:1,guid:x.query,title:'Canonical Title (01-02) (1080p) [Batch]',seeders:5,evidence:'unverified'}]:Array.from({length:25},(_,i)=>({indexerId:1,guid:`single-${i}`,title:`Canonical Title - ${i+1} (1080p)`,seeders:5,evidence:'unverified'}))};}});
 const found=await discover({requestId:1,searchTargetEpisodeId:101});
 assert.ok(calls.some(x=>x.query==='Canonical Title batch'));
 assert.ok(calls.some(x=>x.query==='Official Alias batch'));
 assert.ok(found.items[0].title.includes('[Batch]'));
 assert.ok(calls.length<=16);assert.ok(calls.every(x=>x.limit<=50));assert.ok(found.items.length<=50);
});
test('pack retrieval queries remain same-ID hints with the existing length bound',()=>{
 assert.deepEqual(queries.trustedPackQueries?.('Canonical Title',['Official Alias']),['Canonical Title batch','Official Alias batch']);
 assert.deepEqual(queries.trustedPackQueries?.('x'.repeat(119)),[]);
});
test('episode zero is optional only in explicit standalone coordinates, not words, hashes or ordinary episodes',()=>{
 for(const name of ['[Group] Show - 00v3 (1080p) [C4B61D41].mkv','Show.S01E00.1080p.mkv','Show - E00.mkv','Specials/01.mkv','OVA/01.mkv'])assert.equal(isPackBonusVideo(name),true,name);
 for(const name of ['[Group 00] Show - 01.mkv','Show 2000 - 01.mkv','Show - 00-16.mkv','Show - 01v2.mkv','Show - 0001.mkv',
 '0 Saiji Start Dash Monogatari S01E01.mkv','0 Saiji Start Dash Monogatari - 01.mkv','0 Saiji Start Dash Monogatari.mkv',
 'Show S01E00 S01E01.mkv','Show - 00 - 01.mkv','Show E00 E01.mkv','Show - 00 [S01E01].mkv'])assert.equal(isPackBonusVideo(name),false,name);
});

test('punctuation-neutral same-ID retrieval finds an unlabelled pack without weakening identity titles',async()=>{
 assert.ok(queries.trustedReleaseQueries('Canonical: A Long Subtitle').includes('Canonical A Long Subtitle'));
 assert.ok(!queries.trustedIdentityTitles('Canonical: A Long Subtitle').includes('Canonical A Long Subtitle'));
 const request={id:1,anidbId:10,kind:'series',status:'held',episodeIds:[101,102]};
 const detail={state:'details',anidbId:10,title:'Canonical: A Long Subtitle',kind:'series',restricted:false,page:1,total:2,complete:true,nextPage:null,airDate:'2020-01-01',endDate:'2020-01-08',episodes:[1,2].map(n=>({id:100+n,number:n,type:'Episode',title:`Episode ${n}`,airDate:'2020-01-01'}))};
 const discover=createRequestCandidateDiscovery({readRequest:()=>request,loadDetail:async()=>detail,pause:async()=>{},searchReleases:async({query})=>({state:'candidates',items:[...Array.from({length:48},(_,i)=>({indexerId:1,guid:`single-${i}`,title:`Canonical - A Long Subtitle - ${i+1} (1080p)`,seeders:5,evidence:'unverified'})),...(query==='Canonical A Long Subtitle'?[{indexerId:1,guid:'unlabelled-pack',title:'[WEB] Canonical - A Long Subtitle [1080p][HEVC]',seeders:3,evidence:'unverified'}]:[])]})});
 const found=await discover({requestId:1});assert.equal(found.items[0].guid,'unlabelled-pack');
});
