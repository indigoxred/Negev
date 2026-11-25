import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openAccountLedger} from '../src/auth/account-ledger.mjs';
import {openRequestLedger} from '../src/requests/request-ledger.mjs';
import {openDirectAvailabilityQueue} from '../src/availability/direct-availability-queue.mjs';
import {openFileProofLedger} from '../src/availability/file-proof-ledger.mjs';
import {createFileBackfillScheduler} from '../src/availability/file-backfill-scheduler.mjs';
import {createUserService} from './helpers/scoped-user-service.mjs';
const origin='http://localhost:3000',target={anidbId:42,episodeId:1001};
for(const watching of [false,true])test(`scheduled canonical arrival retry survives restart behind 6201 old direct rows (${watching?'existing Watching after 31 minutes':'manual import without request'})`,async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'arrival-scheduler-')),dbPath=path.join(root,'state.sqlite');
 let service,scheduler,clock=1000,indexed=false,sourceReads=0,cardReads=0;const timers=[];
 const file={ID:51,Updated:'2026-11-02T00:00:00Z',Size:5,IsIgnored:false,SeriesIDs:[{SeriesID:{ID:99,AniDB:42},EpisodeIDs:[{ID:555,AniDB:1001,TMDB:{Movie:[]}}]}],Locations:[{FileID:51,IsAccessible:true,AbsolutePath:'/pure/Anime/one.mkv'}],Release:{ID:null,ProviderName:'User',IsCorrupted:false,CrossReferences:[{AnidbAnimeID:42,AnidbEpisodeID:1001,PercentageStart:0,PercentageEnd:100}]}};
 const card={ratingKey:'500',type:'episode',librarySectionID:102,guid:'tv.plex.agents.custom.shoko://episode/e555',grandparentGuid:'tv.plex.agents.custom.shoko://show/99',Media:[{Part:[{id:900,size:5,file:'/source-pure/Anime/one.mkv'}]}]};
 const fetchImpl=async url=>{
  if(url.pathname==='/api/v3/File/51'){sourceReads++;return Response.json(file);}
  if(url.pathname==='/api/v3/Series/AniDB/42')return Response.json({ID:42,Title:'Example',Type:'TV',AirDate:'2020-01-01',EndDate:'2020-02-01',EpisodeCount:1,Restricted:false});
  if(url.pathname==='/api/v3/Series/AniDB/42/Episode')return Response.json({Total:1,List:[{ID:1001,AnimeID:42,EpisodeNumber:1,Type:'Normal',Title:'One',AirDate:'2020-01-01'}]});
  if(url.pathname==='/library/sections/102')return Response.json({MediaContainer:{librarySectionID:102,Directory:[{type:'4',key:'/library/sections/102/all?type=4'}]}});
  if(url.pathname==='/library/sections/102/all')return Response.json({MediaContainer:{librarySectionID:102,offset:0,totalSize:indexed?1:0,size:indexed?1:0,Metadata:indexed?[card]:[]}});
  if(url.pathname==='/library/metadata/500'){cardReads++;return Response.json({MediaContainer:{size:1,Metadata:[card]}});}
  return new Response(null,{status:503});
 };
 const open=()=>createUserService({dbPath,shokoBaseUrl:'http://shoko:8111/',shokoApiKey:'synthetic',sessionKey:randomBytes(32),publicOrigin:origin,secureCookies:false,now:()=>clock,shokoInventoryHints:true,fileBackfill:true,fileProofLifetimeMs:30*60000,plex:{plexBaseUrl:'http://plex:32400/',plexToken:'synthetic',publicSections:{episode:[102],movie:[]},shokoMount:{appRoot:'/pure',localRoot:root},plexMount:{appRoot:'/source-pure',localRoot:root}},fetchImpl});
 const startScheduler=()=>{scheduler=createFileBackfillScheduler({tick:()=>service.tickFileBackfill(),intervalMs:60000,setTimer:(fn,delay)=>{const timer={fn,delay};timers.push(timer);return timer;},clearTimer:timer=>{const i=timers.indexOf(timer);if(i>=0)timers.splice(i,1);}});scheduler.start();};
 const turn=async()=>{const timer=timers.shift();assert.ok(timer,'scheduler must schedule another bounded turn');clock+=timer.delay;await timer.fn();};
 const proof=()=>{const ledger=openFileProofLedger(dbPath,{positiveLifetimeMs:30*60000,now:()=>clock});try{return ledger.getCurrent(target);}finally{ledger.close();}};
 const signIn=async()=>{const login=await service.app.inject({method:'POST',url:'/api/login',headers:{origin},payload:{username:'Owner',password:'long-owner-passphrase'}});assert.equal(login.statusCode,200,login.body);return login.headers['set-cookie'].split(';')[0];};
 const read=async(cookie,url)=>{const response=await service.app.inject({method:'GET',url,headers:{cookie}});assert.equal(response.statusCode,200,response.body);return response.json();};
 try{
  await mkdir(path.join(root,'Anime'));await writeFile(path.join(root,'Anime','one.mkv'),'video');
  const accounts=openAccountLedger(dbPath);const owner=await accounts.bootstrapAdmin({username:'Owner',password:'long-owner-passphrase'});accounts.close();
  const requests=openRequestLedger(dbPath);if(watching)requests.submit({requesterId:owner.id,requestKey:'existing-watch',nowMs:10,intent:{state:'ready',anidbId:42,title:'Example',kind:'series',monitorFuture:true,episodeIds:[1001]}});requests.close();
  const queue=openDirectAvailabilityQueue(dbPath);queue.close();const db=new DatabaseSync(dbPath);db.exec('BEGIN');const insert=db.prepare("INSERT INTO direct_availability_targets(anidb_id,episode_id,observed_ms,due_ms,version,priority,state,interactive_until_ms) VALUES(?,?,?,?,1,0,'pending',0)");for(let id=1;id<=6201;id++)insert.run(10000+id,20000+id,0,0);db.exec('COMMIT');db.close();
  service=await open();const cookie=await signIn();assert.equal((await read(cookie,'/api/library')).items.length,0);
  service.acceptShokoEvent('file:hashed',[{FileID:51}]);
  for(let attempts=0;attempts<50;attempts++){await new Promise(resolve=>setImmediate(resolve));if(service.getShokoEventState().inFlight===null&&service.getObservedShokoFileIds(target).includes(51))break;}
  assert.deepEqual(service.getObservedShokoFileIds(target),[51],'actual linked event receipt must reach durable inventory');
  await service.tickPublicPlexPage({libraryId:102,kind:'episode'});startScheduler();await turn();
  assert.equal(proof().state,'unknown','first scheduled attempt must miss before the Plex card exists');assert.ok(sourceReads>=3,'event receipt plus actual before/after candidate observations must run');
  await scheduler.close();scheduler=null;await service.close();service=null;
  if(watching)clock+=31*60000; // Expired recent-window memory must not discard unresolved arrival work.
  service=await open();const restartedCookie=await signIn(),before=await read(restartedCookie,'/api/requests?view=watching');
  if(watching){assert.equal(before.items.length,1);assert.equal(before.items[0].progress.publicVerifiedTargets,undefined);}else assert.equal(before.items.length,0);
  indexed=true;clock++;assert.equal((await service.tickPublicPlexPage({libraryId:102,kind:'episode'})).state,'page_indexed');
  assert.equal(proof().state,'unknown','index discovery must not itself fabricate canonical availability');
  startScheduler();for(let attempts=0;attempts<2&&proof().state!=='available';attempts++)await turn();
  assert.equal(proof().state,'available','due scheduled arrival retry must save guarded canonical proof despite historical direct backlog');assert.ok(cardReads>0,'scheduled file worker must reread the actual Plex card');assert.equal(proof().verifiedAtMs,clock,'fresh actual checks receive their own observation time');
  assert.equal((await read(restartedCookie,'/api/library')).items[0].anidbId,42);
  const after=await read(restartedCookie,'/api/requests?view=watching');if(watching){assert.equal(after.items[0].progress.publicVerifiedTargets,1);assert.equal(after.items[0].progress.publicAvailability,'verified_recently');}else assert.deepEqual(after.items,[],'manual imports must not create requests');
  const verify=new DatabaseSync(dbPath);try{assert.equal(verify.prepare('SELECT COUNT(*) n FROM requests').get().n,watching?1:0);assert.equal(verify.prepare('SELECT COUNT(*) n FROM direct_availability_targets WHERE anidb_id>=10001').get().n,6201);assert.deepEqual({...verify.prepare('SELECT file_id,library_id,rating_key,part_id,verified_ms FROM file_availability_proofs WHERE anidb_id=42 AND episode_id=1001').get()},{file_id:51,library_id:102,rating_key:500,part_id:900,verified_ms:clock});}finally{verify.close();}
 }finally{await scheduler?.close();await service?.close();await rm(root,{recursive:true,force:true});}
});
