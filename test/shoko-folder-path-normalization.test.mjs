import test from 'node:test';import assert from 'node:assert/strict';
import {readShokoOneFile} from '../src/availability/shoko-one-file.mjs';import {createShokoEventConsumer} from '../src/availability/shoko-event-consumer.mjs';
for(const [raw,folder,resolved] of [['incoming.mkv',1,true],['/incoming.mkv',1,true],['//incoming.mkv',1,false],['///incoming.mkv',1,false],['/incoming.mkv',2,false],['sub//incoming.mkv',1,false]])test('adapter and event consumer share one strict folder normalization: '+raw+' folder='+folder,async()=>{
 const consumer=createShokoEventConsumer({refreshFile:async()=>({state:'recorded_file',recognition:'linked'})});
 try{
  consumer.accept('file:detected',[{ManagedFolderID:1,RelativePath:'incoming.mkv'}]);const [token]=consumer.snapshotPendingPathResolutions();
  const result=await readShokoOneFile({baseUrl:'http://shoko.invalid/',apiKey:'synthetic',fileId:10,includePaths:true,fetchImpl:async()=>Response.json({ID:10,Updated:'2026-11-28T00:00:00Z',SeriesIDs:[{SeriesID:{AniDB:42},EpisodeIDs:[{AniDB:1001}]}],Locations:[{FileID:10,ManagedFolderID:folder,RelativePath:raw,IsAccessible:true}]})});
  for(const path of result.observedPaths??[])consumer.acknowledgeLinkedPathObservation({token,fileId:10,path,result:{state:'recorded_file',recognition:result.item.state}});
  assert.equal(consumer.getArrivalState().pendingPaths,resolved?0:1);
 }finally{await consumer.close()}
});
