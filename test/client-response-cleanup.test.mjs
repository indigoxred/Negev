import assert from 'node:assert/strict';
import test from 'node:test';

const shoko = { baseUrl: 'http://shoko:8111/', apiKey: 'synthetic', anidbId: 42 };
const hash = 'a'.repeat(40);
const provider = '123e4567-e89b-42d3-a456-426614174000';
const cases = [
  ['catalogue/shoko-hydration', 'requestAniDbHydration', shoko],
  ['catalogue/shoko-search', 'searchAniDbTitles', {...shoko, query:'Example'}],
  ['catalogue/shoko-detail', 'loadAniDbDetail', shoko],
  ['catalogue/shoko-relations', 'readAniDbRelations', shoko],
  ['catalogue/shoko-related-titles', 'readAniDbRelatedTitles', shoko],
  ['catalogue/shoko-poster', 'readShokoPoster', {...shoko, uid:provider}],
  ['catalogue/anidb-related-titles', 'readAniDbRelatedTitles', {anidbId:42, titleForId:()=> 'Example'}],
  ['catalogue/anidb-poster', 'readAniDbPoster', {anidbId:42}],
  ['catalogue/anidb-display-reader', 'createAniDbDisplayReader', {}, 'read', {anidbId:42}],
  ['catalogue/anidb-map-facts', 'createAniDbMapFactsReader', {}, 'read', {anidbId:42}],
  ['catalogue/animap-raw-detail', 'createAniMapRawDetailReader', {timeoutMs:100}, 'read', {anidbId:42}],
  ['catalogue/anidb-group-reader', 'createAniDbGroupReader', {}, 'read'],
  ['catalogue/anidb-title-source', 'createAniDbTitleSource', {}, 'refresh'],
  ['catalogue/anidb-weekly-schedule', 'createAniDbWeeklySchedule', {}, 'read'],
  ['catalogue/seasonal-catalogue', 'createSeasonalCatalogue', {}, 'read', {year:2026,season:'FALL'}],
  ['identity/previously-verified-file', 'readPreviouslyVerifiedFile', {...shoko,prior:{physical:{},fileId:5},shokoMount:{appRoot:'/pure',localRoot:process.cwd()}}],
  ['identity/shoko-ed2k-mode', 'readShokoEd2kMode', shoko],
  ['identity/shoko-preview', 'previewAniDbRelease', {...shoko, providerId:provider, ed2k:'A'.repeat(32), size:1}],
  ['identity/shoko-offline-preview', 'previewOfflineRelease', {...shoko, filename:'Example.mkv'}],
  ['acquisition/shoko-path-file', 'readShokoPathFile', {...shoko, sourcePath:'/Import/Example.mkv'}],
  ['acquisition/shoko-source-folder', 'verifyShokoSourceFolder', {...shoko, folderId:2, shokoPath:'/Import'}],
  ['acquisition/shoko-episode-metadata', 'readShokoEpisodeMetadata', {...shoko, episodeId:11}],
  ['acquisition/shoko-unrecognized-file', 'readShokoUnrecognizedFile', {...shoko, fileId:2}],
  ['acquisition/shoko-video-extensions', 'readShokoVideoExtensions', shoko],
  ['acquisition/qbittorrent-sidecar', 'readQbittorrentSidecarTorrent', {baseUrl:'http://qb/',sessionId:'SID123',hash}],
  ['acquisition/read-stopped-recovery-torrent', 'readStoppedRecoveryTorrent', {baseUrl:'http://qb/',sessionId:'SID123',hash,saveRoot:'/Downloads/negev'}],
  ['acquisition/qbittorrent-login', 'loginQbittorrent', {baseUrl:'http://qb/',username:'synthetic',password:'synthetic'}],
  ['acquisition/request-shoko-file-rescan', 'requestShokoFileRescan', {...shoko,fileId:2}],
];
export function openResponse(status, mode, headers={}) {
  let cancels=0;
  const response = new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('unused'));},cancel(){
    cancels++; if(mode==='pending')return new Promise(()=>{}); if(mode==='reject')return Promise.reject(Error('synthetic cancellation rejection'));
  }}),{status,headers});
  if(mode==='throw')response.body.cancel=()=>{cancels++;throw Error('synthetic cancellation failure');};
  return {response,cancels:()=>cancels};
}
export async function promptly(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('cleanup blocked caller')),500);})]);}finally{clearTimeout(timer);}}
for(const [file,name,input,method,args] of cases){
  const fn=(await import(`../src/${file}.mjs`))[name];
  for(const status of [302,403,503])for(const mode of ['normal','pending','reject','throw']){
    test(`${file} discards ${status} with ${mode} cancellation`,async()=>{
      const fixture=openResponse(status,mode);let calls=0;
      const options={...input,fetchImpl:async()=>{calls++;return fixture.response;}};
      await promptly(method?fn(options)[method](args):fn(options));
      assert.equal(calls,1,'rejection should keep existing single request behavior');
      assert.equal(fixture.cancels(),1,'unused response must be cancelled exactly once');
      assert.equal(fixture.response.body.locked,false);
      await new Promise(resolve=>setImmediate(resolve));
    });
  }
}
const {readShokoPoster}=await import('../src/catalogue/shoko-poster.mjs');
const {readAniDbPoster}=await import('../src/catalogue/anidb-poster.mjs');
const {stopCompletedTorrent}=await import('../src/acquisition/stop-completed-torrent.mjs');
const {deleteStalledTorrent}=await import('../src/acquisition/delete-stalled-torrent.mjs');
const {deletePrestartMismatchTorrent}=await import('../src/acquisition/delete-prestart-mismatch-torrent.mjs');
const {createCatalogueFetch}=await import('../src/catalogue/catalogue-fetch.mjs');
const torrent={hash,category:'negev',save_path:`/Downloads/negev/${hash}`,content_path:`/Downloads/negev/${hash}/01.mkv`,auto_tmm:false,force_start:false,progress:0.2};
const deletion={attemptId:7,baseUrl:'http://qb/',sessionId:'SID123',stagingRoot:'/staging',saveRoot:'/Downloads/negev',nowMs:300,
 verifyStagingRoot:async()=>({state:'verified_staging_root'}), lstatImpl:async()=>({isDirectory:()=>true,isSymbolicLink:()=>false})};
const attempt={id:7,status:'torrent_observed',expectedHash:hash,torrentHash:hash};
for(const mode of ['normal','pending','reject','throw']){
 for(const [kind,headers] of [['type',{'content-type':'text/plain'}],['length',{'content-type':'image/jpeg','content-length':'invalid'}]]){
  for(const name of ['Shoko','AniDB'])test(`${name} poster disposes invalid ${kind} before reading with ${mode} cancellation`,async()=>{
   const f=openResponse(200,mode,headers);
   const result=await promptly(name==='Shoko'?readShokoPoster({...shoko,uid:provider,fetchImpl:async()=>f.response}):readAniDbPoster({anidbId:42,fetchImpl:async url=>String(url).includes('animap')?Response.json({anidb_id:42,picture:'1.jpg'}):f.response}));
   assert.equal(result.state,'unavailable');assert.equal(f.cancels(),1);assert.equal(f.response.bodyUsed,mode!=='throw');
  });
 }
 for(const status of [200,302,403,503]){
  test(`stop POST disposes unused ${status} with ${mode} cancellation`,async()=>{
   const f=openResponse(status,mode);let observations=0;
   const result=await promptly(stopCompletedTorrent({baseUrl:'http://qb/',sessionId:'SID123',expected:{hash,category:'negev',savePath:`/Downloads/negev/${hash}`},fetchImpl:async()=>f.response,observe:async()=>{observations++;return {state:'complete'};}}));
   assert.equal(f.cancels(),1);assert.equal(observations,status===200?2:1);
   assert.equal(result.state,status===200?'complete':'held');
  });
  for(const [label,fn] of [['stalled',deleteStalledTorrent],['mismatch',deletePrestartMismatchTorrent]])test(`${label} deletion POST disposes unused ${status} with ${mode} cancellation`,async()=>{
   const f=openResponse(status,mode);let posts=0;
   const ledger={getAttempt:()=>attempt,getStalledRetirementIntent:()=>({hash,status:'requested'}),beginStalledDelete:()=>({state:'delete_unknown',sendNow:true}),getPrestartMismatchIntent:()=>({hash,status:'requested'}),beginPrestartMismatchDelete:()=>({state:'delete_unknown',sendNow:true})};
   const row=label==='mismatch'?{...torrent,state:'stoppedDL',progress:0,downloaded:0}:torrent;
   const result=await promptly(fn({...deletion,readdirImpl:async()=>[],ledger,fetchImpl:async(url,init)=>{if(init.method==='POST'){posts++;return f.response;}return Response.json(url.pathname.endsWith('/info')?[row]:{save_path:torrent.save_path,download_path:''});}}));
   assert.equal(result.state,'delete_unknown');assert.equal(posts,1);assert.equal(f.cancels(),1);
  });
 }
 for(const headers of [{},{'content-length':'invalid'}])test(`catalogue gate cleanup stays prompt for ${JSON.stringify(headers)} with ${mode} cancellation`,async()=>{
  const f=openResponse(Object.keys(headers).length?200:503,mode,headers);
  const fetchImpl=createCatalogueFetch({fetchImpl:async()=>f.response});
  const result=await promptly(fetchImpl('https://animap.id/api/anidb/42').catch(()=>null));
  assert.equal(f.cancels(),1);assert.equal(result?.status??null,Object.keys(headers).length?null:503);
 });
}
const {previewOfflineRelease}=await import('../src/identity/shoko-offline-preview.mjs');
const {loadAniDbDetail}=await import('../src/catalogue/shoko-detail.mjs');
const retirementModules=await Promise.all(['retire-stalled-absent','retire-prestart-mismatch-absent'].map(name=>import(`../src/acquisition/${name}.mjs`)));
for(const mode of ['normal','pending','reject','throw'])for(const status of [302,403,503]){
 const scenarios=[
  ['offline importer preview',f=>previewOfflineRelease({...shoko,filename:'Example.mkv',fetchImpl:async url=>url.pathname.endsWith('/Provider')?Response.json([{Name:'Offline Importer',IsEnabled:true,ID:provider}]):f.response})],
  ['Shoko episode catalogue',f=>loadAniDbDetail({...shoko,fetchImpl:async url=>url.pathname.endsWith('/42')?Response.json({ID:42,Title:'Example',Type:'TV'}):f.response})],
  ['AniDB poster image',f=>readAniDbPoster({anidbId:42,fetchImpl:async url=>String(url).includes('animap')?Response.json({anidb_id:42,picture:'1.jpg'}):f.response})],
  ...[['stalled',deleteStalledTorrent],['mismatch',deletePrestartMismatchTorrent]].flatMap(([label,fn])=>['info','properties'].map(endpoint=>[`${label} deletion ${endpoint} read`,f=>fn({...deletion,readdirImpl:async()=>[],ledger:{getAttempt:()=>attempt,getStalledRetirementIntent:()=>({hash,status:'requested'}),beginStalledDelete:()=>{throw Error('must not delete');},beginPrestartMismatchDelete:()=>{throw Error('must not delete');},getMediaRetirementIntent:()=>({hash,status:'requested'}),beginMediaDelete:()=>{throw Error('must not delete');},resetMediaDeleteAfterRejection:()=>{},retireMedia:()=>{}},fetchImpl:async url=>url.pathname.endsWith(`/${endpoint}`)?f.response:Response.json([{...torrent,state:'stoppedDL',progress:label==='mismatch'?0:0.2,downloaded:0}])})])),
  ...retirementModules.map((module,index)=>[`retirement absence ${index}`,f=>Object.values(module)[0]({...deletion,ledger:{getAttempt:()=>({...attempt,status:'torrent_observed',rejectionReason:'file_wrong_identity'}),getStalledRetirementIntent:()=>({hash,status:'delete_unknown'}),retireStalled:()=>{},retirePrestartMismatch:()=>{},retireRejected:()=>{}},fetchImpl:async()=>f.response})]),
 ];
 for(const [name,run] of scenarios)test(`${name} disposes ${status} with ${mode} cancellation`,async()=>{
  const f=openResponse(status,mode);await promptly(run(f));assert.equal(f.cancels(),1);assert.equal(f.response.body.locked,false);
 });
}
test('successful Shoko hydration and search keep their body consumers',async()=>{
 const {requestAniDbHydration}=await import('../src/catalogue/shoko-hydration.mjs');
 const {searchAniDbTitles}=await import('../src/catalogue/shoko-search.mjs');
 const hydration=new Response('false'),search=Response.json({Total:0,List:[]});
 assert.deepEqual(await requestAniDbHydration({...shoko,fetchImpl:async()=>hydration}),{state:'queued'});
 assert.deepEqual(await searchAniDbTitles({...shoko,query:'Example',fetchImpl:async()=>search}),{state:'results',total:0,page:1,items:[]});
 assert.equal(hydration.bodyUsed,true);assert.equal(search.bodyUsed,true);
});
test('session fetch deliberately transfers body ownership to its caller',async()=>{
 const {createQbittorrentSessionFetch}=await import('../src/acquisition/qbittorrent-session-fetch.mjs');
 const f=openResponse(403,'normal');let invalidated=0;
 const fetchImpl=createQbittorrentSessionFetch({baseUrl:'http://qb/',sessionId:'SID123',sessionGate:{invalidate(){invalidated++;}},fetchImpl:async()=>f.response});
 assert.equal(await fetchImpl('http://qb/api/v2/torrents/info',{redirect:'manual',headers:{Cookie:'SID=SID123'}}),f.response);
 assert.equal(invalidated,1);assert.equal(f.cancels(),0);await f.response.body.cancel();
});

const {readAniDbRelations}=await import('../src/catalogue/shoko-relations.mjs');
const {observeTorrentCompletion}=await import('../src/acquisition/qbittorrent-observation.mjs');
for(const mode of ['normal','pending','reject','throw']){
 test(`Shoko relations disposes 404 while preserving detail_pending with ${mode} cancellation`,async()=>{
  const fixture=openResponse(404,mode);
  assert.deepEqual(await promptly(readAniDbRelations({...shoko,fetchImpl:async()=>fixture.response})),{state:'detail_pending',anidbId:42});
  assert.equal(fixture.cancels(),1);assert.equal(fixture.response.body.locked,false);
  await new Promise(resolve=>setImmediate(resolve));
 });
 for(const status of [302,403,503])test(`qBittorrent observation invokes cancel exactly once for ${status} with ${mode} cancellation`,async()=>{
  const fixture=openResponse(status,mode);
  const cancel=fixture.response.body.cancel.bind(fixture.response.body);let invocations=0;
  fixture.response.body.cancel=(...args)=>{invocations++;return cancel(...args);};
  assert.deepEqual(await promptly(observeTorrentCompletion({baseUrl:'http://qb/',sessionId:'SID123',expected:{hash,category:'negev',savePath:`/Downloads/negev/${hash}`},fetchImpl:async()=>fixture.response})),{state:'held',reason:status===403?'provider_http_403':'provider_http_error'});
  assert.equal(invocations,1);assert.equal(fixture.cancels(),1);assert.equal(fixture.response.body.locked,false);
  await new Promise(resolve=>setImmediate(resolve));
 });
}

for(const mode of ['normal','pending','reject','throw'])test(`episode metadata disposes 404 while preserving missing with ${mode} cancellation`,async()=>{
 const {readShokoEpisodeMetadata}=await import('../src/acquisition/shoko-episode-metadata.mjs');
 const fixture=openResponse(404,mode);
 assert.deepEqual(await promptly(readShokoEpisodeMetadata({...shoko,episodeId:11,fetchImpl:async()=>fixture.response})),{state:'missing'});
 assert.equal(fixture.cancels(),1);assert.equal(fixture.response.body.locked,false);
 await new Promise(resolve=>setImmediate(resolve));
});
