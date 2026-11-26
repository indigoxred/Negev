import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openRequestLedger} from '../src/requests/request-ledger.mjs';
import {openAcquisitionLedger} from '../src/acquisition/acquisition-ledger.mjs';
import {openAcquisitionRequestQueue,createAcquisitionPageWorker} from '../src/acquisition/acquisition-request-queue.mjs';
import {createAcquisitionRequestProcessor} from '../src/acquisition/acquisition-request-processor.mjs';
import {createRequestCompletionReader} from '../src/requests/request-completion-history.mjs';
import {openDirectAvailabilityQueue} from '../src/availability/direct-availability-queue.mjs';
import {openPlexCardIndex} from '../src/availability/plex-card-index.mjs';
import {verifyCachedPositiveCoverage} from '../src/acquisition/verify-cached-positive-coverage.mjs';
import {recentPublicCoverage} from '../src/availability/recent-public-coverage.mjs';

for(const retainedProof of [true,false])test(`withdrawn Plex witness cannot complete a new request: retained proof ${retainedProof}`,async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'negev-public-cache-')),file=path.join(root,'state.sqlite');
 const requests=openRequestLedger(file),acquisitions=openAcquisitionLedger(file),direct=openDirectAvailabilityQueue(file),cards=openPlexCardIndex(file),db=new DatabaseSync(file);
 let queue=openAcquisitionRequestQueue(file),clock=1000,reads=0;const cache=new Map(),target={anidbId:42,episodeId:1001},proof={fileId:9,libraryId:102,ratingKey:500,partId:600};
 const card={libraryId:102,ratingKey:500,kind:'episode',observedMs:100,parts:[{libraryId:102,partId:600,size:1000,plexPath:'/public/example.mkv'}]};cards.recordCard(card);
 if(retainedProof){direct.enqueue({...target,observedMs:100});const claim=direct.claimNext({nowMs:100});direct.recordResult({claim,state:'available',checkedMs:101,proof});}
 const coverage=request=>verifyCachedPositiveCoverage({request,cache,now:()=>clock,ownedEpisodeIds:[1001],
  cached:recentPublicCoverage({episodeIds:request.episodeIds,includeIds:true,titleIds:[],directIds:direct.getRecentAvailableIds({anidbId:42,nowMs:clock})}),
  readRevision:()=>JSON.stringify([1,[[9,100]],direct.getObservation(target)?.observedMs]),
  readWitnessVersion:()=>direct.getWitnessVersion(),isWitnessCurrent:input=>direct.isWitnessCurrent(input),
  readShoko:async()=>{reads++;return{state:'ok',complete:true,files:[{fileId:9}]}},
  readPublic:async()=>cards.getCardRevision({libraryId:102,ratingKey:500})?{state:'available',proof}:{state:'unknown'}});
 const process=createAcquisitionRequestProcessor({readRequest:id=>requests.getRequest(id),readPublicCoverage:coverage,loadDetail:async()=>{},discoverCandidates:async()=>{throw Error('No safe absence established')},previewCandidate:async()=>{},submitCandidate:async()=>{throw Error('No downloads')},now:()=>clock});
 const save=key=>requests.submit({requesterId:1,requestKey:key,intent:{state:'ready',anidbId:42,title:'Example',kind:'series',monitorFuture:false,episodeIds:[1001]},nowMs:clock});
 const run=id=>createAcquisitionPageWorker({queue,processRequest:process,limit:1,now:()=>clock}).runOnce({priorityRequestId:id});
 try{
 const first=save('first');await run(first.requestId);assert.equal(reads,1);assert.equal(createRequestCompletionReader(db)(first.requestId),true);
 cards.forgetCard({libraryId:102,ratingKey:500,observedMs:1100});clock=1100;const second=save('second');await run(second.requestId);
 assert.equal(queue.getResult(second.requestId).reason,'availability_unverified');assert.equal(reads,2,'withdrawal forces current exact reads');
 clock+=300001;queue.close();queue=openAcquisitionRequestQueue(file);assert.equal(createRequestCompletionReader(db)(second.requestId),false);assert.equal(createRequestCompletionReader(db)(first.requestId),true,'legitimate historical completion stays settled');
 const third=save('third');await run(third.requestId);assert.equal(queue.getResult(third.requestId).reason,'availability_unverified');
 }finally{queue.close();db.close();cards.close();direct.close();acquisitions.close();requests.close();await rm(root,{recursive:true,force:true})}
});

test('unrelated card changes preserve reuse and an in-flight matching withdrawal cannot publish a positive',async()=>{
 const cache=new Map();let version=0,changed=false,reads=0;const request={id:1,anidbId:42,kind:'series',episodeIds:[1001]},proof={fileId:9,libraryId:102,ratingKey:500,partId:600};
 const input={request,cache,cached:{verifiedTargets:0,targetCount:1,availableEpisodeIds:[]},ownedEpisodeIds:[1001],now:()=>100,
  readWitnessVersion:()=>version,isWitnessCurrent:()=>!changed,
  readShoko:async()=>{reads++;return{state:'ok',complete:true,files:[{fileId:9}]}},readPublic:async()=>({state:'available',proof})};
 assert.equal((await verifyCachedPositiveCoverage(input)).verifiedTargets,1);version++;assert.equal((await verifyCachedPositiveCoverage(input)).verifiedTargets,1);assert.equal(reads,1,'unrelated changes do not restart a coverage sweep');
 cache.clear();const result=await verifyCachedPositiveCoverage({...input,readPublic:async()=>{changed=true;return{state:'available',proof}}});assert.equal(result.verifiedTargets,0);assert.deepEqual(result.uncertainEpisodeIds,[1001]);
});

for(const warm of [false,true])test(`final coverage revalidates earlier concurrent positives and cache hits: ${warm}`,async()=>{
 const cache=new Map(),request={id:1,anidbId:42,kind:'series',episodeIds:[1001,1002]};let changed=false;
 const proof=id=>({fileId:id===1001?9:10,libraryId:102,ratingKey:id,partId:id});
 const input={request,cache,cached:{verifiedTargets:0,targetCount:2,availableEpisodeIds:[]},
  ownedEpisodeIds:[1001,1002],now:()=>100,readWitnessVersion:()=>0,
  isWitnessCurrent:({proof})=>proof.fileId!==9||!changed,
  readShoko:async()=>({state:'ok',complete:true,files:[{fileId:9}]}),
  readPublic:async target=>({state:'available',proof:proof(target.episodeId)})};
 if(warm){await verifyCachedPositiveCoverage(input);cache.delete('42:series:1002');}
 const result=await verifyCachedPositiveCoverage({...input,readPublic:async target=>{
  if(target.episodeId===1002){await new Promise(resolve=>setImmediate(resolve));changed=true;}
  return{state:'available',proof:proof(target.episodeId)};
 }});
 assert.deepEqual(result.availableEpisodeIds,[1002]);
 assert.deepEqual(result.uncertainEpisodeIds,[1001]);
});
