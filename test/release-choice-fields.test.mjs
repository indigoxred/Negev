import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseFacts, matchesReleaseFilters, validReleaseFilters } from '../src/web/public/release-choice-fields.mjs';
const filters={quality:'bd1080',audio:'japanese'};
test('quality default includes BD with or without a stated resolution and1080p+',()=>{
 for(const title of ['[G] Show [BD]','[G] Show BD 720p','[G] Show BD 1080p','[G] Show WEB 1080p','[G] Show 1440p','[G] Show 2160p'])
   assert.equal(matchesReleaseFilters({title},filters),true,title);
 assert.equal(matchesReleaseFilters({title:'[G] Show WEB 720p'},filters),false);
 assert.equal(matchesReleaseFilters({title:'[G] Show DVD 480p'},{...filters,quality:'all'}),true);
});
test('Japanese-only filtering excludes dual audio; English dub requires its explicit filter',()=>{
 assert.equal(matchesReleaseFilters({title:'[SubsPlease] Show1080p'},{...filters,quality:'all'}),true);
 assert.equal(matchesReleaseFilters({title:'[G] Show 1080p English Dub'},filters),false);
 assert.equal(matchesReleaseFilters({title:'[G] Show 1080p Dual Audio'},filters),false);
 assert.equal(matchesReleaseFilters({title:'[G] Show 1080p Dual Audio'},{...filters,audio:'japanese_dual'}),true);
 assert.equal(matchesReleaseFilters({title:'[G] Show 1080p English Dub'},{...filters,audio:'english'}),true);
 assert.equal(matchesReleaseFilters({title:'[G] Show 1080p'},{...filters,audio:'english'}),false);
});

test('manual defaults retain all four Helck packs, including dual-audio alternatives',()=>{
 const packs=[
  {title:'[SeriousChat] Helck (01-24) [1080p]',seeders:7},
  {title:'[NAN0] Helck (01-24) [BD 1080p] [Dual Audio]',seeders:9},
  {title:'[Sokudo] Helck (01-24) [BD 1080p] [Dual Audio]',seeders:44},
  {title:'Helck S01 Complete 1080p WEB-DL Dual Audio-VARYG',seeders:21},
 ];
 assert.deepEqual(packs.filter(pack=>matchesReleaseFilters(pack)).map(pack=>pack.seeders),[7,9,44,21]);
 assert.deepEqual(packs.filter(pack=>matchesReleaseFilters(pack,filters)).map(pack=>pack.seeders),[7]);
 assert.equal(matchesReleaseFilters({title:'[G] Helck Complete 1080p English Dub'}),false);
});
test('group hints recognize common prefixes and metadata-adjacent suffixes without treating quality as a group',()=>{
 assert.equal(releaseFacts('[SubsPlease] Show - 07 [1080p]').group,'SubsPlease');
 assert.equal(releaseFacts('Show S02E07 1080p CR WEB-DL AAC2.0 H.264-VARYG (Multi-Subs)').group,'VARYG');
 assert.equal(releaseFacts('[1080p] Show [AAC]').group,null);
 assert.equal(releaseFacts('[BD] Show [AABBCCDD]').group,null);
});
test('filter values are bounded enums and source is independent from resolution',()=>{
 assert.equal(validReleaseFilters(filters),true);assert.equal(validReleaseFilters({...filters,audio:'anything'}),false);
 assert.equal(releaseFacts('[G] Show BDRip 1920x1080').source,'BD');
 assert.equal(releaseFacts('[G] Show BDRip 1920x1080').resolution,1080);
 assert.equal(releaseFacts('[G] Show UHD 3840x2160').resolution,2160);
});

test('source and resolution hints normalize release separators without changing group or audio hints',()=>{
 for(const separator of [' ','_','.','-']){
  for(const [source,expected] of [['BD','BD'],['BDRip','BD'],['BDRemux','BD'],[`Blu${separator}ray`,'BD'],[`WEB${separator}DL`,'WEB'],['WEBRip','WEB'],['DVD','DVD']]){
   const title=`[Actual_Group] Example${separator}${source}${separator}1080p${separator}HEVC`,facts=releaseFacts(title);
   assert.equal(facts.source,expected,title);assert.equal(facts.resolution,1080,title);
   assert.equal(facts.group,'Actual_Group');assert.equal(facts.audio,'unknown');
  }
  for(const [tag,resolution] of [['2160p',2160],['4K',2160],['UHD',2160],['3840x2160',2160],['1440p',1440],['1920x1080',1080],['1280x720',720]]){
   assert.equal(releaseFacts(`Example${separator}WEB${separator}${tag}${separator}HEVC`).resolution,resolution,tag+separator);
  }
 }
});
test('separator normalization preserves BD720 default and explicit audio filters',()=>{
 for(const separator of [' ','_','.','-']){
  const title=fields=>`[Actual_Group] ${fields.join(separator)}`;
  assert.equal(matchesReleaseFilters({title:title(['Example','BD','720p','HEVC'])}),true);
  assert.equal(matchesReleaseFilters({title:title(['Example','WEB','720p','HEVC'])}),false);
  const dub=title(['Example','BD','1080p','English','Dub']);assert.equal(matchesReleaseFilters({title:dub}),false);
  assert.equal(matchesReleaseFilters({title:dub},{...filters,audio:'english'}),true);
  assert.equal(matchesReleaseFilters({title:title(['Example','BD','1080p','Dual','Audio'])}),true);
 }
});
