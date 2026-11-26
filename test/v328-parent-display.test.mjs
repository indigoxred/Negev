import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {openRequestLedger} from '../src/requests/request-ledger.mjs';
import {openParentWatchLedger} from '../src/requests/parent-watch-ledger.mjs';
import {createParentWatchWorker} from '../src/requests/parent-watch-worker.mjs';
import {openPendingTitleLedger} from '../src/requests/pending-title-ledger.mjs';
import {createPendingTitleWorker} from '../src/requests/pending-title-worker.mjs';
import {createHeldRequestSubmitter} from '../src/requests/submit-held-request.mjs';
import {openAccountLedger} from '../src/auth/account-ledger.mjs';
import {autoTrackSavedAiringRequest} from '../src/web/auto-track-request.mjs';
import {mergeDisplayFacts} from '../src/catalogue/merge-display-facts.mjs';
import {createAniDbMapFactsReader} from '../src/catalogue/anidb-map-facts.mjs';
import {buildUserApp} from '../src/web/user-app.mjs';
const detail=id=>({state:'details',anidbId:id,kind:'series',title:`Anime ${id}`,airDate:'2026-11-01',endDate:null,episodeCount:12,restricted:false,complete:true,total:1,page:1,nextPage:null,episodes:[{id:id*100,number:1,title:'Episode 1',type:'Episode',airDate:'2026-11-01'}]});
const intent=id=>({state:'ready',anidbId:id,kind:'series',episodeIds:[],monitorFuture:true,title:`Anime ${id}`});
async function isolated(run){const dir=await mkdtemp(join(tmpdir(),'negev-v328-display-'));try{await run(join(dir,'state.sqlite'));}finally{await rm(dir,{recursive:true,force:true});}}

test('parent worker continues beyond foreign watches across restarts and revisits new installments',async()=>isolated(async db=>{
 let requests=openRequestLedger(db),parents=openParentWatchLedger(db),ids=[11,12];
 requests.submit({requesterId:8,requestKey:'existing',intent:intent(11),nowMs:1000});parents.adopt({tvdbId:100,requesterId:7,sourceSeriesId:42,nowMs:1000});
 const run=()=>createParentWatchWorker({parents,requests,mapReader:{read:async()=>({version:2,anime:ids.map(id=>({anidb_id:id,tvdb_id:100}))})},loadDetail:async({anidbId})=>detail(anidbId),readRelations:async id=>({state:'related_titles',anidbId:id,items:[]}),today:()=> '2026-11-12',now:()=>2000}).runOnce();
 try{assert.equal((await run()).result.state,'reconciled');assert.ok(requests.findActiveWatch({requesterId:7,anidbId:12}));
  for(let cycle=0;cycle<3;cycle++){parents.close();requests.close();requests=openRequestLedger(db);parents=openParentWatchLedger(db);await run();ids=[11,12,13];await run();}
  assert.equal(requests.countRequests(),3);assert.equal(requests.findActiveWatch({requesterId:7,anidbId:11}),null);assert.ok(requests.findActiveWatch({requesterId:8,anidbId:11}));assert.ok(requests.findActiveWatch({requesterId:7,anidbId:13}));
  const foreign=requests.findActiveWatch({requesterId:8,anidbId:11});
  assert.equal(requests.cancelRequest({requesterId:8,requestId:foreign,nowMs:3000}).state,'cancelled');
  await run();await run();assert.ok(requests.findActiveWatch({requesterId:7,anidbId:11}));assert.equal(requests.countRequests(),4);
 }finally{parents.close();requests.close();}
}));

test('foreign monitoring settles pending preparation without retry after restart',async()=>isolated(async db=>{
 let ledger=openPendingTitleLedger(db);const requests=openRequestLedger(db);let ms=1000,ready=false;
 for(const requesterId of [7,8])ledger.enqueue({requesterId,anidbId:11,title:'Anime 11',requestKey:`key-${requesterId}`,nowMs:ms});
 const submit=createHeldRequestSubmitter({confirmKnownTitle:async()=>true,loadDetail:async()=>ready?detail(11):{state:'detail_pending',anidbId:11},ledger:requests,now:()=>ms,today:()=> '2026-11-12',authorizeRequester:async()=>({active:true,adultAllowed:true})});
 const run=()=>createPendingTitleWorker({ledger,submitRequest:submit,authorize:async()=>true,now:()=>ms}).runOnce();
 try{assert.equal((await run()).state,'pending');assert.equal((await run()).state,'pending');ms=31000;ready=true;assert.equal((await run()).state,'resolved');assert.deepEqual(await run(),{state:'complete',intentId:2,reason:'already_monitored_elsewhere'});
  ledger.close();ledger=openPendingTitleLedger(db);ms=100000000;assert.equal((await run()).state,'idle');assert.equal(ledger.get(2).state,'complete');assert.equal(requests.countRequests(),1);assert.equal(ledger.get(2).normalRequestId,null);assert.equal(requests.findActiveWatch({requesterId:8,anidbId:11}),null);
 }finally{ledger.close();requests.close();}
}));

test('opening older pending ledgers settles previously deferred foreign monitoring outcomes',async()=>isolated(async db=>{
 let ledger=openPendingTitleLedger(db);ledger.enqueue({requesterId:8,anidbId:11,title:'Anime 11',requestKey:'old',nowMs:1000});const claim=ledger.claimDue({nowMs:1000,leaseMs:1000});ledger.defer({intentId:claim.id,version:claim.version,nowMs:1000,delayMs:30000,reason:'already_monitored_elsewhere'});
 ledger.enqueue({requesterId:8,anidbId:12,title:'Anime 12',requestKey:'control',nowMs:1000});ledger.close();ledger=openPendingTitleLedger(db);
 try{assert.equal(ledger.get(1).state,'complete');assert.equal(ledger.get(1).reason,'already_monitored_elsewhere');assert.equal(ledger.get(2).state,'pending');assert.equal(ledger.claimDue({nowMs:1000000,leaseMs:1000}).id,2);}finally{ledger.close();}
}));

test('request replay respects explicit untrack after account-ledger restart',async()=>isolated(async db=>{
 let accounts=openAccountLedger(db);const requests=openRequestLedger(db);const user=await accounts.bootstrapAdmin({username:'Review',password:'isolated-long-test-pass'});accounts.setAiringPreferences({userId:user.id,mode:'custom',trackedAnidbIds:[]});
 const command={requesterId:user.id,requestKey:'track',intent:intent(11),nowMs:1000};const track=result=>autoTrackSavedAiringRequest({result,requesterId:user.id,anidbId:11,readRequest:id=>requests.getRequest(id),accounts});
 try{track(requests.submit(command));assert.deepEqual(accounts.getAiringPreferences({userId:user.id}).trackedAnidbIds,[11]);accounts.changeAiringPreferences({userId:user.id,action:'untrack',anidbId:11});accounts.close();accounts=openAccountLedger(db);const replay=requests.submit(command);assert.equal(replay.created,false);track(replay);assert.deepEqual(accounts.getAiringPreferences({userId:user.id}),{mode:'custom',trackedAnidbIds:[]});assert.ok(requests.findActiveWatch({requesterId:user.id,anidbId:11}));assert.equal(requests.countRequests(),1);
 }finally{accounts.close();requests.close();}
}));
const display={state:'display',anidbId:11,title:'Anime 11',restricted:false,englishTitle:'English 11',type:'TV',startYear:2020,startDate:'2020-01-01',endDate:'2024-01-01',episodeCount:12,description:'Usable description',tags:[]};
const facts=seconds=>createAniDbMapFactsReader({fetchImpl:async()=>new Response(JSON.stringify({sources:['https://anidb.net/anime/11'],animeSeason:{season:'WINTER',year:2020},status:'FINISHED',duration:{unit:'SECONDS',value:seconds}}))}).read({anidbId:11});
test('multi-year runs retain end dates while pre-season placeholders stay suppressed',async()=>{
 const metadata=await facts(1200);assert.equal(mergeDisplayFacts(display,metadata).endDate,'2024-01-01');assert.equal(mergeDisplayFacts({...display,endDate:'1970-01-01'},metadata).endDate,null);assert.equal(mergeDisplayFacts({...display,endDate:'2019-12-31'},metadata).endDate,null);assert.equal(mergeDisplayFacts({...display,startYear:1970,startDate:'1970-01-01',endDate:'1970-01-01'},metadata).startDate,null);
});
async function authenticatedApp(run){
 const user={id:7,username:'Review',role:'member',sessionVersion:1,adultAllowed:true};let item={anidbId:11,title:'Original 11',englishTitle:'English 11',scheduledDate:'2026-11-20',episodeNumber:'1',adult:false,libraryPresence:{state:'unknown',verifiedEpisodeCount:0}},current=display,preference;const prefs={mode:'custom',trackedAnidbIds:[11]};
 const app=await buildUserApp({accounts:{getAiringPreferences:()=>prefs,authenticate:async()=>user,getSessionUser:()=>user,registerInvite:async()=>null,createInvite:()=>null,revokeSessions:()=>false},sessionKey:randomBytes(32),publicOrigin:'http://localhost:3000',secureCookies:false,now:()=>1000,submitRequest:async()=>null,readRequest:()=>null,confirmKnownTitle:async()=>true,readDisplayMetadata:async()=>current,listAiringSchedule:async input=>{preference=input.airingPreference;return {state:'ready',week:'2026-W47',checkedMs:1000,items:[item]};}});
 try{const login=await app.inject({method:'POST',url:'/api/login',headers:{origin:'http://localhost:3000'},payload:{username:'Review',password:'isolated-long-test-pass'}});assert.equal(login.statusCode,200);const cookie=login.headers['set-cookie'].split(';')[0];await run({get:url=>app.inject({method:'GET',url,headers:{cookie}}),setItem:v=>item=v,setDisplay:v=>current=v,getPreference:()=>preference,prefs});}finally{await app.close();}
}
test('authenticated weekly serialization preserves optional English titles and account preferences',async()=>authenticatedApp(async({get,setItem,getPreference,prefs})=>{
 let response=await get('/api/airing');assert.equal(response.statusCode,200);assert.equal(response.json().items[0].englishTitle,'English 11');assert.deepEqual(getPreference(),prefs);const item=response.json().items[0];delete item.englishTitle;setItem(item);response=await get('/api/airing');assert.equal(response.statusCode,200);assert.equal(response.json().items[0].englishTitle,undefined);setItem({...item,englishTitle:42});assert.equal((await get('/api/airing')).statusCode,503);
}));
test('sub-minute runtime retains authenticated description and dates',async()=>authenticatedApp(async({get,setDisplay})=>{
 setDisplay(mergeDisplayFacts(display,await facts(20)));const response=await get('/api/catalogue/11/display');assert.equal(response.statusCode,200);assert.equal(response.json().description,display.description);assert.equal(response.json().endDate,display.endDate);assert.equal(response.json().durationMinutes,null);setDisplay(mergeDisplayFacts(display,await facts(1200)));const control=await get('/api/catalogue/11/display');assert.equal(control.statusCode,200);assert.equal(control.json().durationMinutes,20);
}));
