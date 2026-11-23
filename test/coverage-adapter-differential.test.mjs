import assert from 'node:assert/strict';
import test from 'node:test';
import {readShokoEpisodeFiles} from '../src/availability/shoko-episode-files.mjs';
import {readShokoFileCandidate} from '../src/availability/shoko-file-candidate.mjs';
const digest='A'.repeat(32);
function file(range){return {ID:51,Updated:'2026-11-01T00:00:00Z',Size:123,IsIgnored:false,Hashes:[{Type:'ED2K',Value:digest}],SeriesIDs:[{SeriesID:{ID:99,AniDB:42},EpisodeIDs:[{ID:555,AniDB:1001,TMDB:{Movie:[]}}]}],Release:{ID:`anidb://${digest}+123`,ProviderName:'AniDB',ReleaseURI:'https://anidb.net/file/800',FileSize:123,IsCorrupted:false,Hashes:[{Type:'ED2K',Value:digest}],CrossReferences:[{AnidbAnimeID:42,AnidbEpisodeID:1001,PercentageStart:range[0],PercentageEnd:range[1]}]},Locations:[{FileID:51,IsAccessible:true,AbsolutePath:'/pure/01.mkv'}]};}
async function both(f){const common={baseUrl:'http://shoko:8111',apiKey:'synthetic'};return Promise.all([readShokoEpisodeFiles({...common,anidbId:42,episodeId:1001,purpose:'availability',fetchImpl:async u=>Response.json(u.pathname.includes('/Episode/')?{IDs:{ID:555,ParentSeries:99,AniDB:1001},Files:[f]}:f)}),readShokoFileCandidate({...common,fileId:51,fetchImpl:async()=>Response.json(f)})]);}
for(const [name,range]of [['null',[null,null]],['full',[0,100]],['partial',[20,80]],['empty',[0,0]]])test(`availability adapters agree on ${name} after exact identity validation`,async()=>{
 const [episode,candidate]=await both(file(range));
 if(name==='empty'){assert.equal(episode.state,'unavailable');assert.equal(candidate.state,'unavailable');return;}
 assert.equal(episode.state,'ok');assert.equal(candidate.state,'candidate');
 assert.deepEqual(candidate.coverage??[{episodeId:1001,start:0,end:100}],episode.files[0].coverage);
});
test('raw invalid identities cannot hide in empty ranges',async()=>{
 for(const extra of [{AnidbAnimeID:99,AnidbEpisodeID:1002},{AnidbAnimeID:42,AnidbEpisodeID:1001}]){
 const f=file([0,100]);f.Release.CrossReferences.push({...extra,PercentageStart:0,PercentageEnd:0});
 const [episode,candidate]=await both(f);assert.equal(episode.state,'unavailable');assert.equal(candidate.state,'unavailable');
 }
});
test('same-file local ranges recover serialized empty links identically in both adapters',async()=>{
 const f=file([0,0]);f.SeriesIDs[0].EpisodeIDs[0].Source='AniDB';
 f.SeriesIDs[0].EpisodeIDs[0].Percentage={Start:10,End:90};
 const [episode,candidate]=await both(f);
 assert.equal(episode.state,'ok');assert.equal(candidate.state,'candidate');
 assert.deepEqual(candidate.coverage,episode.files[0].coverage);
 assert.deepEqual(candidate.coverage,[{episodeId:1001,start:10,end:90}]);
});
test('User null ranges use full coverage consistently without claiming registration',async()=>{
 const f=file([null,null]);f.Release={ID:null,ProviderName:'User',IsCorrupted:false,CrossReferences:f.Release.CrossReferences};
 const [episode,candidate]=await both(f);assert.equal(episode.state,'ok');assert.equal(candidate.state,'candidate');
 assert.equal(candidate.releaseEvidence,'shoko_user_link');
 assert.deepEqual(episode.files[0].coverage,[{episodeId:1001,start:0,end:100}]);
});
