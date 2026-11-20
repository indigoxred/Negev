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
test('unknown and filename-only registration stay unknown; mixed packs are not confirmed',()=>{
 assert.equal(correspondenceLevel(selection('Example 1080p','filename_prediction').preview),'unknown');
 const p=selection('Example 1080p','previously_verified').preview;
 p.files.push({name:'b.mkv',size:100,episodeIds:[2]}); assert.notEqual(correspondenceLevel(p),'confirmed');
});
test('Auto offers a material source improvement but unattended defaults to the registered 1080p',()=>{
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
