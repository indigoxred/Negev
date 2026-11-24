import {createHash} from 'node:crypto';
import {initializePreferredReleases,getPreferredFallback} from '../src/acquisition/preferred-release.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openRequestLedger} from '../src/requests/request-ledger.mjs';
import {openAcquisitionLedger} from '../src/acquisition/acquisition-ledger.mjs';
import {createAcquisitionRequestProcessor} from '../src/acquisition/acquisition-request-processor.mjs';
import {fetchProwlarrTorrentBytes} from '../src/acquisition/prowlarr-torrent-bytes.mjs';

for(const changedHash of [false,true])for(const variant of ['chosen','proposal','fallback','chosen-guid','proposal-guid','fallback-guid'])test(`legacy ${variant} locator migrates on reopen and ${changedHash?'rejects changed bytes without substitution':'uses current credentials over HTTP'}`,async()=>{
 const phase=variant.replace('-guid','');
 const calls=[];
 const provider=createServer((req,res)=>{calls.push({url:new URL(req.url,'http://localhost'),key:req.headers['x-api-key']});res.setHeader('content-type','application/x-bittorrent');res.end('d4:infodee');});
 await new Promise(r=>provider.listen(0,'127.0.0.1',r));
 const baseUrl=`http://127.0.0.1:${provider.address().port}/`;
 const dir=await mkdtemp(path.join(tmpdir(),'negev-exact-rotation-'));const dbPath=path.join(dir,'state.sqlite');
 let requests=openRequestLedger(dbPath);const acquisitions=openAcquisitionLedger(dbPath);
 try {
  requests.submit({requesterId:1,requestKey:'exact',nowMs:100,intent:{state:'ready',anidbId:42,kind:'series',monitorFuture:true,episodeIds:[101]}});
  const candidate={guid:variant.endsWith('-guid')?`${baseUrl}1/download?apikey=obsoleteFakeKey&link=exactToken&file=Example`:'selected-release',indexerId:1,title:'[Exact] Example - 01 WEB 1080p',size:1000,seeders:20,evidence:'unverified',proxyUrl:`${baseUrl}1/download?apikey=obsoleteFakeKey&link=exactToken&file=Example`};
  const preview={state:'preflight',requestId:1,anidbId:42,torrentHash:'a'.repeat(40),episodeIds:[101],files:[{name:'Example - 01.mkv',size:1000,episodeIds:[101]}]};
  const selection={candidate,preview};
  // Write the previous-version schema's actual JSON to simulate an upgrade,
  // rather than invoking the new serializer and calling that migration.
  const db=new DatabaseSync(dbPath);
  if(phase==='fallback'){
   db.prepare('UPDATE requests SET release_control=? WHERE id=1').run(JSON.stringify({mode:'auto',phase:'consumed',revision:1,preference:{group:'Preferred',audio:'japanese',knownEpisodeIds:[],createdMs:100}}));
   db.prepare('INSERT INTO preferred_release_waits(request_id,episode_id,first_seen_ms,deadline_ms,fallback_json) VALUES(1,101,100,200,?)').run(JSON.stringify(selection));
  }else db.prepare('UPDATE requests SET release_control=? WHERE id=1').run(JSON.stringify(phase==='chosen'?{mode:'manual',phase,revision:1,selection}:{mode:'auto',phase,revision:1,expiresMs:200,proposal:{registered:selection,better:{...selection,candidate:{...candidate,guid:'never-substitute'}}}}));
  db.close();requests.close();requests=openRequestLedger(dbPath);
  const inspect=new DatabaseSync(dbPath);
  const persisted=JSON.stringify([...inspect.prepare('SELECT release_control FROM requests').all(),...inspect.prepare('SELECT fallback_json FROM preferred_release_waits').all()]);inspect.close();
  assert.equal(persisted.includes('obsoleteFakeKey'),false,'opening old records removes stored authentication');
  let discoveries=0,submitted=0;
  const process=createAcquisitionRequestProcessor({now:()=>1000,readRequest:id=>requests.getRequest(id),readReleaseControl:requests.getReleaseControl.bind(requests),getPreferredFallback:requests.getPreferredFallback.bind(requests),
   readPublicCoverage:async()=>({targetCount:1,verifiedTargets:0,availableEpisodeIds:[]}),
   discoverCandidates:async()=>{discoveries++;return {state:'held',reason:'release_search_unavailable'};},
   loadDetail:async()=>({state:'details',anidbId:42,complete:true,total:1,restricted:false,kind:'series',title:'Example',episodes:[{id:101,type:'Episode',number:1}]}),
   previewCandidate:async({candidate:exact})=>{assert.equal(exact.guid.includes('obsoleteFakeKey'),false);const result=await fetchProwlarrTorrentBytes({baseUrl,apiKey:'currentFakeKey',query:'Example',candidate:exact,indexerIds:[1]});assert.equal(result.state,'torrent_bytes',JSON.stringify(result));return changedHash?{...preview,torrentHash:'b'.repeat(40)}:preview;},
   submitCandidate:async input=>{submitted++;const result=acquisitions.reserve({requestId:1,candidate:input.candidate,episodeIds:input.episodeIds,preparedHash:input.expectedHash,plannedFiles:input.plannedFiles,nowMs:1000});assert.equal(result.state,'reserved',JSON.stringify(result));return {state:'stopped_observed',attemptId:result.attemptId};}});
  const result=await process({requestId:1});assert.equal(result.state,changedHash?'held':'stopped_observed',JSON.stringify(result));assert.equal(submitted,changedHash?0:1);if(changedHash)assert.equal(result.reason,phase==='fallback'?'release_preflight_unavailable':'release_choice_changed');assert.equal(discoveries,phase==='fallback'?1:0);
  assert.equal(calls.length,1);assert.equal(calls[0].url.pathname,'/1/download');assert.equal(calls[0].key,'currentFakeKey');assert.equal(calls[0].url.searchParams.get('apikey'),'currentFakeKey');assert.equal(calls[0].url.searchParams.get('link'),'exactToken');
 }finally{requests.close();acquisitions.close();provider.closeAllConnections();await new Promise(r=>provider.close(r));await rm(dir,{recursive:true,force:true});}
});

test('an unreadable legacy fallback stays unusable without blocking unrelated database startup', async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'negev-bad-fallback-'));const dbPath=path.join(dir,'state.sqlite');
 let requests=openRequestLedger(dbPath);
 try{
  requests.submit({requesterId:1,requestKey:'corrupt',nowMs:100,intent:{state:'ready',anidbId:42,kind:'series',monitorFuture:true,episodeIds:[101]}});
  const db=new DatabaseSync(dbPath);db.prepare('INSERT INTO preferred_release_waits(request_id,episode_id,first_seen_ms,deadline_ms,fallback_json) VALUES(1,101,100,200,?)').run('{"candidate":{"proxyUrl":');db.close();requests.close();requests=null;
  const migration=new DatabaseSync(dbPath);try{assert.doesNotThrow(()=>initializePreferredReleases(migration));assert.equal(getPreferredFallback(migration,1,[101],1000),null);}finally{migration.close();}
 }finally{requests?.close();await rm(dir,{recursive:true,force:true});}
});

test('legacy credential-bearing GUID reservations retain identity through rotation and reopen',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'negev-guid-alias-'));const dbPath=path.join(dir,'state.sqlite');let requests=openRequestLedger(dbPath);let acquisitions=openAcquisitionLedger(dbPath);
 try{
  requests.submit({requesterId:1,requestKey:'guid',nowMs:100,intent:{state:'ready',anidbId:42,kind:'series',monitorFuture:false,episodeIds:[101]}});
  const oldGuid='http://prowlarr.invalid/1/download?apikey=oldFakeGuidKey&link=exact&file=Example';
  const candidate={guid:oldGuid,indexerId:1,title:'[Exact] Example - 01 1080p',size:1000};const hash='a'.repeat(40),files=[{name:'Example - 01.mkv',size:1000,episodeIds:[101]}];
  const reserved=acquisitions.reserve({requestId:1,candidate,episodeIds:[101],nowMs:101});assert.equal(reserved.state,'reserved');
  const db=new DatabaseSync(dbPath);db.prepare('UPDATE acquisition_attempts SET candidate_digest=? WHERE id=?').run(createHash('sha256').update(oldGuid).digest('hex'),reserved.attemptId);
  db.prepare('UPDATE requests SET release_control=? WHERE id=1').run(JSON.stringify({mode:'manual',phase:'chosen',revision:1,selection:{candidate,preview:{torrentHash:hash,episodeIds:[101],files}}}));db.close();
  acquisitions.close();requests.close();requests=openRequestLedger(dbPath);acquisitions=openAcquisitionLedger(dbPath);
  const saved=requests.getReleaseControl(1,102).selection.candidate;
  assert.equal(JSON.stringify(saved).includes('oldFakeGuidKey'),false);
  const rotated={...candidate,guid:oldGuid.replace('oldFakeGuidKey','currentFakeGuidKey')};
  const replay=acquisitions.reserve({requestId:1,candidate:rotated,episodeIds:[101],preparedHash:hash,plannedFiles:files,nowMs:102});
  assert.equal(replay.state,'existing',JSON.stringify(replay));assert.equal(replay.attemptId,reserved.attemptId);
  assert.equal(acquisitions.bindPreparedTorrent({attemptId:reserved.attemptId,candidate:saved,hash,nowMs:103}).state,'prepared');
 }finally{acquisitions.close();requests.close();await rm(dir,{recursive:true,force:true});}
});
