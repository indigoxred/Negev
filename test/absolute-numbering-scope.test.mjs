import assert from 'node:assert/strict';import test from 'node:test';
import {verifyAbsoluteNumberingScope}from'../src/acquisition/absolute-numbering-scope.mjs';
const detail=(id,count)=>({state:'details',anidbId:id,title:'Example '+id,kind:'series',restricted:false,total:count,complete:true,page:1,nextPage:null,episodes:Array.from({length:count},(_,i)=>({id:id*100+i+1,number:i+1,type:'Episode',title:'Episode '+(i+1)}))});
const relations=(id,ids)=>({state:'related_titles',anidbId:id,items:ids.map(anidbId=>({anidbId,title:'Earlier '+anidbId,relation:'prequel'}))});
test('regular prequel counts establish scope without using the larger Specials maximum',async()=>{
 const result=await verifyAbsoluteNumberingScope({anidbId:42,offset:24,readRelatedTitles:async({anidbId})=>relations(anidbId,anidbId===42?[43]:[]),loadDetail:async()=>{const d=detail(43,24);return {...d,total:25,episodes:[...d.episodes,{id:99999,number:99,type:'Special',title:'Special'}]};}});
 assert.equal(result.state,'scope_confirmed');assert.equal(result.offset,24);
});
test('a full prequel chain is required instead of stopping at a coincidental subtotal',async()=>{
 const readRelatedTitles=async({anidbId})=>relations(anidbId,anidbId===42?[43]:anidbId===43?[44]:[]),loadDetail=async({anidbId})=>detail(anidbId,12);
 assert.equal((await verifyAbsoluteNumberingScope({anidbId:42,offset:12,readRelatedTitles,loadDetail})).state,'unverified');
 assert.equal((await verifyAbsoluteNumberingScope({anidbId:42,offset:24,readRelatedTitles,loadDetail})).state,'scope_confirmed');
});
test('first installments, cycles, branching ancestry, gaps, wrong metadata and provider failure are not offset evidence',async()=>{
 for(const mode of ['first','cycle','branch','gap','wrong','failure']){
  const readRelatedTitles=async({anidbId})=>{if(mode==='failure')throw Error('offline');return relations(anidbId,mode==='first'?[]:mode==='branch'?[43,44]:mode==='cycle'?(anidbId===42?[43]:[42]):anidbId===42?[43]:[]);};
  const loadDetail=async({anidbId})=>{const d=detail(anidbId,12);if(mode==='wrong')d.anidbId=999;if(mode==='gap')d.episodes[0].number=99;return d;};
  assert.equal((await verifyAbsoluteNumberingScope({anidbId:42,offset:12,readRelatedTitles,loadDetail})).state,'unverified',mode);
 }
});

test('temporary prequel providers retain failure provenance while genuine scope uncertainty does not',async()=>{
 const base={anidbId:42,offset:24,related:relations(42,[43]),readRelatedTitles:async({anidbId})=>relations(anidbId,[])};
 for(const mode of ['pending','unavailable','busy','throw']){
  const loadDetail=async()=>{if(mode==='throw')throw Error('synthetic outage');return mode==='pending'?{state:'detail_pending',anidbId:43}:mode==='busy'?{state:'held',reason:'metadata_reader_busy'}:{state:'unavailable'};};
  assert.deepEqual(await verifyAbsoluteNumberingScope({...base,loadDetail}),{state:'unverified',reason:'provider_unavailable'},mode);
 }
 assert.deepEqual(await verifyAbsoluteNumberingScope({...base,loadDetail:async()=>({...detail(43,24),anidbId:999})}),{state:'unverified'});
 assert.deepEqual(await verifyAbsoluteNumberingScope({...base,related:relations(42,[43,44]),loadDetail:async()=>detail(43,24)}),{state:'unverified'});
});
