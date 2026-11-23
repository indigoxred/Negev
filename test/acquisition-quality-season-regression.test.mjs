import { createReleaseSelection } from '../src/acquisition/release-selection.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { openAcquisitionLedger } from '../src/acquisition/acquisition-ledger.mjs';
import { createAcquisitionStageProcessors } from '../src/acquisition/acquisition-stage-processors.mjs';
import { createRequestCandidateDiscovery } from '../src/acquisition/request-candidate-discovery.mjs';
import { previewRequestCandidate } from '../src/acquisition/request-candidate-preflight.mjs';
import { prepareStoppedCandidate } from '../src/acquisition/prepare-stopped-candidate.mjs';
import { inspectTorrentMetainfo } from '../src/acquisition/inspect-torrent-metainfo.mjs';

const encode = value => Buffer.isBuffer(value) ? Buffer.concat([Buffer.from(value.length+':'),value]) :
  typeof value === 'string' ? encode(Buffer.from(value)) : typeof value === 'number' ? Buffer.from('i'+value+'e') :
  Array.isArray(value) ? Buffer.concat([Buffer.from('l'),...value.map(encode),Buffer.from('e')]) :
  Buffer.concat([Buffer.from('d'),...Object.keys(value).sort().flatMap(k=>[encode(k),encode(value[k])]),Buffer.from('e')]);
const release = (guid,title,numbers=[1],seeders=10) => ({guid,indexerId:3,title,seeders,
  names:numbers.map(n=>'Example - '+String(n).padStart(2,'0')+'.mkv')});

// Real stage/ledger/discovery/preflight/submission. Only outside services are synthetic.
async function fixture(t,{title='Example',aliases=[],items,episodes=2,requested=[1],completed=false,registered=false,prediction=true}={}) {
  const root=await mkdtemp(path.join(tmpdir(),'negev-worker-quality-season-'));
  const dbPath=path.join(root,'db.sqlite');const requests=openRequestLedger(dbPath),acquisitions=openAcquisitionLedger(dbPath);
  t.after(async()=>{acquisitions.close();requests.close();await rm(root,{recursive:true,force:true});});
  const detail={state:'details',anidbId:42,title,kind:'series',restricted:false,complete:true,page:1,total:episodes,nextPage:null,
    airDate:'2026-01-01',endDate:completed?'2026-02-01':null,episodeCount:completed?episodes:episodes+10,
    episodes:Array.from({length:episodes},(_,i)=>({id:1001+i,number:i+1,type:'Episode',title:'Episode '+(i+1),airDate:'2026-01-01'}))};
  const saved=requests.submit({requesterId:1,requestKey:'desired',nowMs:100,intent:{state:'ready',anidbId:42,title,kind:'series',monitorFuture:!completed,episodeIds:requested.map(n=>1000+n)}});
  const records=items.map(c=>{
    const names=c.names??['Example - 01.mkv'];const size=names.length*1000;
    const info={name:names.length===1?names[0]:'Pack','piece length':16384,pieces:createHash('sha1').update(c.guid).digest(),
      ...(names.length===1?{length:1000}:{files:names.map(name=>({length:1000,path:[name]}))})};
    const bytes=encode({info});const metadata=inspectTorrentMetainfo({bytes});assert.equal(metadata.state,'metainfo_checked');
    const proxy='http://prowlarr:9696/3/download?apikey=synthetic&link='+c.guid+'&file=release';
    return {...c,size,bytes,metadata,protocol:'torrent',downloadUrl:proxy};
  });
  const searchRows=records.map(({names,bytes,metadata,...c})=>c);
  const prowlarrFetch=async input=>{const url=new URL(input);if(url.pathname==='/api/v1/search')return Response.json(searchRows);
    const record=records.find(c=>c.guid===url.searchParams.get('link'));assert.ok(record,'only known synthetic descriptor');return new Response(record.bytes,{headers:{"content-type":"application/x-bittorrent"}});};
  const related={state:'related_titles',anidbId:42,items:aliases.length?[{anidbId:41,title:'Example',relation:'Prequel'}]:[]};
  const readRelatedTitles=async()=>related,releaseQueries=async()=>aliases,loadDetail=async()=>detail;
  const readRequest=id=>requests.getRequest(id);const inspected=[];
  const discoverCandidates=createRequestCandidateDiscovery({readRequest,loadDetail,releaseQueries,pause:async()=>{},
    searchReleases:async()=>({state:'candidates',items:searchRows.map(c=>({...c,evidence:'unverified'}))})});
  const previewCandidate=async input=>{inspected.push(input.candidate.guid);const checked=await previewRequestCandidate({...input,readRequest,loadDetail,releaseQueries,readRelatedTitles,
    offlineLookup:async({filename})=>{if(!prediction)return {status:204};const id=1000+Number(filename.split(' - ')[1]?.slice(0,2));return {status:200,release:{ProviderName:'Offline Importer',IsCorrupted:false,OriginalFilename:filename,ID:'offline://42-'+id,CrossReferences:[{AnidbAnimeID:42,AnidbEpisodeID:id,PercentageStart:0,PercentageEnd:100}]}};},
    inspectCorrespondence:async({files})=>({files:files.map(f=>({...f,state:registered?'likely':'unknown'}))}),
    prepare:input=>prepareStoppedCandidate({baseUrl:'http://prowlarr:9696/',apiKey:'synthetic',indexerIds:[3],fetchImpl:prowlarrFetch,...input})});return checked;};
  const added=[],started=[];let active=null;
  const qbitFetch=async(input,options={})=>{
    const url=new URL(input);
    if(url.pathname.endsWith('/start')){started.push(active.guid);return new Response('Ok.');}
    if(url.pathname.endsWith('/version'))return new Response('v5.3.0');
    if(url.pathname.endsWith('/add')){
      const blob=options.body.get('torrents');const meta=inspectTorrentMetainfo({bytes:new Uint8Array(await blob.arrayBuffer())});
      active=records.find(c=>c.metadata.hash===meta.hash);assert.ok(active);added.push(active.guid);
      assert.equal(options.body.get('stopped'),'true','normal stage must add stopped');return new Response('Ok.');
    }
    if(url.pathname.endsWith('/info'))return Response.json(active?[{hash:active.metadata.hash,category:'negev',save_path:'/Downloads/negev/'+active.metadata.hash,state:'stoppedDL',progress:0,downloaded:0,amount_left:active.size,auto_tmm:false,force_start:false}]:[]);
    if(url.pathname.endsWith('/properties'))return Response.json({save_path:'/Downloads/negev/'+active.metadata.hash,download_path:''});
    if(url.pathname.endsWith('/files'))return Response.json(active.metadata.files.map((f,index)=>({...f,index,priority:1,progress:0})));
    throw Error('Unexpected qBittorrent endpoint '+url.pathname);
  };
  const stages=createAcquisitionStageProcessors({readVideoExtensions:async()=>({state:"extensions",values:[".mkv"]}),requests,acquisitions,handoffs:{getHandoff:()=>null},discoverCandidates,previewCandidate,loadDetail,releaseQueries,readRelatedTitles,
    readPublicCoverage:async request=>({verifiedTargets:0,targetCount:request.episodeIds.length,availableEpisodeIds:[],uncertainEpisodeIds:[]}),
    readEvidence:async({anidbId,episodeIds})=>({anidbId,episodeIds,observedAtMs:200,importFence:{state:'settled',anidbId,episodeIds,beforeObservedAtMs:199,afterObservedAtMs:200},shoko:{state:'ok',complete:true,files:[]},plex:{state:'ok',complete:true,sourceVerified:true,libraryIds:[102],parts:[]}}),
    publicSections:{episode:[102],movie:[123]},prowlarr:{baseUrl:'http://prowlarr:9696/',apiKey:'synthetic',indexerIds:[3]},
    stagingHostPath:'/srv/negev/staging',qbitStagingRoot:'/Downloads/negev',holdingRoot:'/srv/negev/holding',importRoot:'/srv/shoko/import',
    verifyStagingRoot:async()=>({state:'verified_staging_root'}),realpathImpl:async p=>p,ensureImportRoot:async()=>({state:'import_child_ready'}),verifyShokoSource:async()=>({state:'verified_shoko_source'}),
    shoko:{baseUrl:'http://shoko:8111/',apiKey:'synthetic',providerId:'11111111-2222-4333-8444-555555555555'},now:()=>201});
  return {added,started,inspected,requests,acquisitions,requestId:saved.requestId,
    runStart:attemptId=>stages.processStart({attemptId,qbittorrent:{baseUrl:"http://qb:8080/",sessionId:"syntheticSID"},fetchImpl:qbitFetch}),
    selection:createReleaseSelection({requests,discoverCandidates,previewCandidate,loadDetail,now:()=>201,
      readPublicCoverage:async()=>({availableEpisodeIds:[],uncertainEpisodeIds:[]})}),
    run:input=>stages.processRequest({requestId:saved.requestId,qbittorrent:{baseUrl:'http://qb:8080/',sessionId:'syntheticSID'},fetchImpl:qbitFetch,providerFetchImpl:prowlarrFetch,...input})};
}

for(const resolution of [720,1080])for(const registered of [false,true])test(`actual worker submits ${resolution}p instead of targeted480p (${registered?'likely':'unknown'} correspondence)`,async t=>{
  const f=await fixture(t,{registered,prediction:registered,items:[release('low','[G] Example - 01 WEB 480p',[1],5),release('high','[G] Example WEB '+resolution+'p',[1],30)]});
  const result=await f.run();assert.equal(result.state,'stopped_observed',JSON.stringify(result));assert.deepEqual(f.added,['high']);
  assert.deepEqual(f.acquisitions.getFilePlan(result.attemptId).map(f=>f.episodeIds),[[1001]]);
  const repeat=await f.run();assert.equal(repeat.state,'held');assert.equal(f.added.length,1,'repeated worker run cannot add another torrent');
});

test('actual worker retains a viable older480p fallback when no better release exists',async t=>{
  const f=await fixture(t,{registered:true,items:[release('old','[G] Example - 01 DVD 480p',[1],1)]});
  const result=await f.run();assert.equal(result.state,'stopped_observed',JSON.stringify(result));assert.deepEqual(f.added,['old']);
});

test('a1080p candidate for another episode cannot defeat the correct480p fallback',async t=>{
  const f=await fixture(t,{registered:true,items:[release('wrong','[G] Example - 02 WEB 1080p',[2],30),release('right','[G] Example - 01 WEB 480p',[1],5)]});
  const result=await f.run();assert.equal(result.state,'stopped_observed',JSON.stringify(result));assert.deepEqual(f.added,['right']);
});

for(const alias of ['Example Second Season','Example Final Season','Example Spring Season'])test(`actual stage passes trusted textual season episode through final guarded submit: ${alias}`,async t=>{
  const f=await fixture(t,{title:'Example Season 2',aliases:[alias],registered:true,
    items:[{...release('text','[G] '+alias+' - 01 [1080p]'),names:[alias+' - 01.mkv']}]});
  const result=await f.run();assert.equal(result.state,'stopped_observed',JSON.stringify(result));assert.deepEqual(f.added,['text']);
});

test('actual stage rejects explicit wrong-season coordinates even with a trusted textual alias',async t=>{
  const alias='Example Second Season';const f=await fixture(t,{title:'Example Season 2',aliases:[alias],registered:true,
    items:[{...release('wrong','[G] '+alias+' S01E01 [1080p]'),names:[alias+' S01E01.mkv']}]});
  const result=await f.run();assert.equal(result.state,'held');assert.deepEqual(f.added,[]);
});

test('completed seasons still submit a complete pack ahead of a higher-resolution single episode',async t=>{
  const f=await fixture(t,{completed:true,requested:[1,2],registered:true,items:[release('single','[G] Example - 01 BD 1080p'),release('pack','[G] Example Batch 720p',[1,2],8)]});
  const result=await f.run();assert.equal(result.state,'stopped_observed',JSON.stringify(result));assert.deepEqual(f.added,['pack']);assert.deepEqual(f.acquisitions.getFilePlan(result.attemptId).flatMap(f=>f.episodeIds),[1001,1002]);
});



test('Manual Pick preserves the exact trusted textual-season choice until the real worker submits it',async t=>{
  const alias='Example Second Season';const f=await fixture(t,{title:'Example Season 2',aliases:[alias],registered:true,
    items:[{...release('manual','[G] '+alias+' - 01 [1080p]'),names:[alias+' - 01.mkv']}]});
  const initial=f.selection.snapshot(f.requestId);
  const begun=f.selection.begin(f.requestId,'manual',initial.revision);assert.equal(begun.state,'updated');
  const found=await f.selection.search(f.requestId);assert.equal(found.state,'candidates');
  const token=found.items[0].token;const inspected=await f.selection.inspect(f.requestId,token);assert.equal(inspected.state,'preflight',JSON.stringify(inspected));
  const choice=await f.selection.choose(f.requestId,token,begun.control.revision);assert.equal(choice.state,'updated',JSON.stringify(choice));
  const result=await f.run();assert.equal(result.state,'stopped_observed',JSON.stringify(result));assert.deepEqual(f.added,['manual']);
  assert.equal(f.requests.getReleaseControl(f.requestId,201).phase,'consumed');
});


test('a higher-quality generic title with wrong descriptor episodes cannot trigger a grab',async t=>{
  const f=await fixture(t,{registered:true,items:[release('wrongfiles','[G] Example WEB 1080p',[2],30),release('correct','[G] Example - 01 WEB 480p',[1],5)]});
  const result=await f.run();assert.equal(result.state,'stopped_observed',JSON.stringify(result));assert.deepEqual(f.added,['correct']);assert.ok(f.inspected.includes('wrongfiles'));
});

for(const alias of ['Example Second Season','Example Final Season','Example Spring Season'])test('actual stage starts exact saved textual-season release once: '+alias,async t=>{
 const f=await fixture(t,{title:'Example Season 2',aliases:[alias],registered:true,items:[{...release('text','[G] '+alias+' - 01 [1080p]'),names:[alias+' - 01.mkv']}]});
 const result=await f.run();assert.equal(result.state,'stopped_observed');
 const start=await f.runStart(result.attemptId);assert.equal(start.state,'start_unknown',JSON.stringify(start));
 assert.deepEqual(f.started,['text']);await f.runStart(result.attemptId);assert.deepEqual(f.started,['text']);
});

for(const mode of ['auto','manual'])for(const language of ['German','French','Spanish'])test('actual '+mode+' path never dispatches an explicit '+language+'-subtitles-only release',async t=>{
 const f=await fixture(t,{registered:true,items:[release('foreign','[G] Example - 01 1080p [Japanese Audio] ['+language+' Subtitles Only]')]});
 if(mode==='auto'){const r=await f.run();assert.equal(r.state,'held');assert.deepEqual(f.added,[])}else{
  const initial=f.selection.snapshot(f.requestId);f.selection.begin(f.requestId,'manual',initial.revision);
  const filtered=await f.selection.search(f.requestId);assert.equal(filtered.items.length,0);
  const unfiltered=await f.selection.search(f.requestId,undefined,0,null);assert.equal(unfiltered.items.length,1);
  const selected=await f.selection.choose(f.requestId,unfiltered.items[0].token,f.selection.snapshot(f.requestId).revision);assert.equal(selected.state,'held');assert.equal(selected.reason,'release_not_eligible');assert.deepEqual(f.added,[]);
 }
});

for(const mode of ['auto','manual'])for(const tag of ['English / Dutch / German Subtitles Only','English SDH / German Subtitles Only'])test('actual '+mode+' worker accepts complete multilingual clause: '+tag,async t=>{
 const f=await fixture(t,{registered:true,items:[release('multilingual','[G] Example - 01 1080p [Japanese Audio] ['+tag+']')]});
 if(mode==='manual'){const initial=f.selection.snapshot(f.requestId);const begun=f.selection.begin(f.requestId,'manual',initial.revision);const found=await f.selection.search(f.requestId);assert.equal(found.items.length,1);const inspected=await f.selection.inspect(f.requestId,found.items[0].token);assert.equal(inspected.state,'preflight');assert.equal((await f.selection.choose(f.requestId,found.items[0].token,begun.control.revision)).state,'updated');}
 const result=await f.run();assert.equal(result.state,'stopped_observed',JSON.stringify(result));assert.deepEqual(f.added,['multilingual']);await f.run();assert.deepEqual(f.added,['multilingual']);
});
