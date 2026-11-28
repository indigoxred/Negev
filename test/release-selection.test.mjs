import test from 'node:test';
import assert from 'node:assert/strict';
import { publicRelease, chooseReleaseProposal, correspondenceLevel } from '../src/acquisition/release-selection.mjs';
const candidate=(title,seeders=20)=>({title,guid:title,indexerId:1,size:1000,seeders,evidence:'unverified'});
const selection=(title,state,seeders)=>({candidate:candidate(title,seeders),preview:{torrentHash:'a'.repeat(40),episodeIds:[1],files:[{name:'a.mkv',size:1000,episodeIds:[1]}],correspondence:{state,files:[{name:'a.mkv',size:1000,state}]}}});
test('public release metadata exposes hints, not proxy URLs or false language guarantees',()=>{
 const result=publicRelease({...candidate('[Group] Example - 01 [WEB 1080p] [Dual Audio]'),proxyUrl:'https://private/?apikey=secret'});
 assert.equal(result.group,'Group');assert.equal(result.resolution,1080);assert.equal(result.source,'WEB');
 assert.match(result.languageHints,/advertised/i);assert.equal(JSON.stringify(result).includes('secret'),false);
});
test('season labels do not misdescribe individual release coverage or explicit dub language',()=>{
 assert.match(publicRelease(candidate('[SubsPlease] Example S2 - 07 (1080p)')).coverage,/Episode 7 advertised/);
 assert.match(publicRelease(candidate('[Yameii] Example - S02E05 [English Dub] [1080p]')).coverage,/Episode 5 advertised/);
 assert.match(publicRelease(candidate('[Yameii] Example - S02E05 [English Dub] [1080p]')).languageHints,/English dub advertised/);
 assert.match(publicRelease(candidate('[G] Example S02E01-E12 [1080p]')).coverage,/Season pack/);
});
test('unknown and filename-only registration stay unknown; mixed packs are not confirmed',()=>{
 assert.equal(correspondenceLevel(selection('Example 1080p','filename_prediction').preview),'unknown');
 const p=selection('Example 1080p','previously_verified').preview;
 p.files.push({name:'b.mkv',size:100,episodeIds:[2]}); assert.notEqual(correspondenceLevel(p),'confirmed');
});
test('Auto offers a material source improvement over a likely AniDB match without claiming exact proof',()=>{
 const registered=selection('[G] Example WEB 1080p','likely');
 const better=selection('[H] Example BD 1080p','unknown');
 const decision=chooseReleaseProposal([better,registered]);
 assert.equal(decision.registered,registered);assert.equal(decision.better,better);
 assert.match(decision.benefit,/Blu-ray/i);
});
test('registration cannot make 480p or 720p beat a suitable 1080p release',()=>{
 const best=selection('Example 1080p','unknown');
 const lower=selection('Example 480p','previously_verified');
 assert.equal(chooseReleaseProposal([lower,best]).selection,best);
 assert.equal(chooseReleaseProposal([selection('Example 720p','likely'),best]).selection,best);
});
test('the 1080p standard is preserved when a lower-resolution candidate advertises Blu-ray',()=>{
 const best=selection('Example WEB 1080p','unknown');
 const lower=selection('Example BD 720p','likely');
 assert.equal(chooseReleaseProposal([lower,best]).selection,best);
});
test('different coverage does not produce a misleading better-release comparison',()=>{
 const a=selection('Example WEB 1080p','likely');const b=selection('Example BD 1080p','unknown');
 b.preview.episodeIds=[2];assert.equal(chooseReleaseProposal([a,b]).better,undefined);
});

test('AniDB correspondence cannot demote a seeded1080p candidate across a peer threshold',()=>{
 const high=selection('Show WEB 1080p','unknown',2),low=selection('Show WEB 480p','likely',3);
 assert.equal(chooseReleaseProposal([low,high]).selection,high);
});

for(const [tag,source] of [['BD_1080p','Blu-ray'],['WEB_1080p','WEB'],['DVD_480p','DVD']])test('selected source label agrees with normalized release facts for '+tag,()=>{
 const shown=publicRelease(candidate('[Group] Example '+tag));assert.equal(shown.source,source);assert.match(shown.qualityLabel,new RegExp(tag.split('_')[0]));
});
