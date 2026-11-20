import assert from 'node:assert/strict';import test from 'node:test';import {readShokoEpisodeMetadata} from '../src/acquisition/shoko-episode-metadata.mjs';
test('metadata existence is exact and distinguishes an outage from absence',async()=>{
 for(const[status,body,state]of[[200,{ID:11,AnimeID:42},'present'],[404,{},'missing'],[500,{},'unavailable'],[200,{ID:11,AnimeID:99},'unavailable']]){
 const result=await readShokoEpisodeMetadata({baseUrl:'http://shoko:8111/',apiKey:'synthetic',anidbId:42,episodeId:11,fetchImpl:async()=>Response.json(body,{status})});assert.equal(result.state,state);
 }
});
