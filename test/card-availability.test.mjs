import assert from 'node:assert/strict';
import test from 'node:test';
import {catalogueAvailability,validRegularCoverage} from '../src/web/public/card-availability.mjs';
import {cachedRegularCoverage} from '../src/web/card-coverage.mjs';
const full={total:28,verified:8,aired:28,verifiedAired:8,upcoming:0,undated:0};
test('catalogue coverage is partial, complete or up-to-date without counting future episodes missing',()=>{
 const presence=regularCoverage=>({state:'in_library',verifiedEpisodeCount:99,regularCoverage});
 assert.equal(catalogueAvailability(presence(full),'FINISHED').text,'Partial · 8/28 episodes');
 assert.equal(catalogueAvailability(presence({...full,verified:28,verifiedAired:28}),'FINISHED').text,'28/28 episodes available');
 assert.equal(catalogueAvailability(presence({...full,total:12,aired:8,upcoming:4}),'ONGOING').text,'All 8 aired episodes available');
 assert.equal(catalogueAvailability(presence({...full,total:8,aired:8}),'ONGOING').text,'All 8 aired episodes available');
});
test('aggregate item counts and malformed coverage never become episode fractions',()=>{
 assert.equal(catalogueAvailability({state:'in_library',verifiedEpisodeCount:8}).text,'In library · coverage unconfirmed');
 assert.equal(validRegularCoverage({...full,verified:40}),false);
 assert.equal(catalogueAvailability({state:'unknown',verifiedEpisodeCount:0}),null);
});
test('cached projection intersects exact regular IDs and excludes Specials',()=>{
 const episodes=[{id:1,type:'Episode',airDate:'2026-01-01'},{id:2,type:'Episode',airDate:'2026-01-08'},{id:3,type:'Episode',airDate:'2026-12-01'}];
 const coverage=cachedRegularCoverage({index:{regularIds:[1,2,3],regularEpisodes:episodes},verifiedIds:new Set([1,900]),asOf:'2026-11-21'});
 assert.deepEqual(coverage,{total:3,verified:1,aired:2,verifiedAired:1,upcoming:1,undated:0});
 assert.equal(cachedRegularCoverage({index:null,verifiedIds:new Set([1]),asOf:'2026-11-21'}),undefined);
});

test('Specials are counted separately and never inflate regular coverage',()=>{
 const index={kind:'series',regularIds:[1,2],regularEpisodes:[{id:1,type:'Episode',airDate:'2026-01-01'},{id:2,type:'Episode',airDate:'2026-01-02'}],specialEpisodes:[{id:900,type:'Special'}]};
 const regularCoverage=cachedRegularCoverage({index,verifiedIds:new Set([1,900]),asOf:'2026-11-21'});
 const badge=catalogueAvailability({state:'in_library',regularCoverage});
 assert.equal(badge.text,'Partial · 1/2 episodes');assert.equal(badge.specialText,'1/1 Special available');assert.equal(badge.specialState,'available');
});
