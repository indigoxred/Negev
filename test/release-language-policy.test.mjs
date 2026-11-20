import assert from 'node:assert/strict';
import test from 'node:test';
import {assessRelease} from '../src/acquisition/release-preference.mjs';
import {matchesReleaseFilters} from '../src/web/public/release-choice-fields.mjs';
const candidate=tag=>({title:'[Group] Example 1080p '+tag,seeders:20});
test('Auto and Japanese+dual manual selection reject explicit incompatible language declarations',()=>{
 for(const tag of ['Russian Dub','French Dub','German Dub','Spanish Dub','No Subs','No Subtitles','Unsubbed','RAW Only','Dual Audio Russian Dub','Russian Audio','Dubbed in French','Portuguese Dub','No English Subs','Russian Dub Japanese Subs','English Dub Japanese Subs']){
  assert.equal(assessRelease(candidate(tag)).eligible,false,tag);
  assert.equal(matchesReleaseFilters(candidate(tag),{quality:'all',audio:'japanese_dual'}),false,tag);
 }
});
test('unknown, burned-in English and Japanese+English dual releases remain eligible',()=>{
 for(const tag of ['','Hardsub','Japanese Audio English Subs','Dual Audio English Subs','Japanese Audio English Dub English Subs']){
  assert.equal(assessRelease(candidate(tag)).eligible,true,tag);
  assert.equal(matchesReleaseFilters(candidate(tag),{quality:'all',audio:'japanese_dual'}),true,tag);
 }
 assert.equal(assessRelease({...candidate('English Dub English Subs'),selectionPolicy:{allowEnglishDub:true}}).eligible,true);
 assert.equal(assessRelease({...candidate('Russian Dub'),selectionPolicy:{allowEnglishDub:true}}).eligible,false);
 assert.equal(matchesReleaseFilters(candidate('English Dub English Subs'),{quality:'all',audio:'english'}),true);
 assert.equal(matchesReleaseFilters(candidate('Dual Audio'),{quality:'all',audio:'japanese'}),false);
});

test('underscore-separated explicit audio and subtitle declarations follow the same policy',()=>{
 for(const title of ['Example_1080p_Russian_Dub','Example_1080p_NoSubs','Example_1080p_English_Dub']){
  const c={title,seeders:20};assert.equal(assessRelease(c).eligible,false,title);assert.equal(matchesReleaseFilters(c,{quality:'all',audio:'japanese_dual'}),false,title);
 }
});
