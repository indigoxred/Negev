import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, stat, rename, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openRequestLedger } from '../src/requests/request-ledger.mjs';
import { openAcquisitionLedger } from '../src/acquisition/acquisition-ledger.mjs';
import { openPureMoveLedger } from '../src/acquisition/pure-move-ledger.mjs';
import { processShokoRescan } from '../src/acquisition/process-shoko-rescan.mjs';
import { openShokoRescanLedger } from '../src/acquisition/shoko-rescan-ledger.mjs';

async function fixture({ policyBeforeAttempt = true, publishedMs = 209 } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-rescan-'));
  const dbPath = path.join(root, 'state.sqlite');
  const requests = openRequestLedger(dbPath);
  const submitted = requests.submit({ requesterId: 1, requestKey: 'pack',
    nowMs: 100, intent: { state: 'ready', anidbId: 42,
      kind: 'series', monitorFuture: false,
      episodeIds: Array.from({ length: 12 }, (_, i) => 1001 + i) } });
  requests.close();
  const acquisition = openAcquisitionLedger(dbPath);
  const moves = openPureMoveLedger(dbPath);
  let rescan = policyBeforeAttempt ? openShokoRescanLedger(dbPath) : null;
  const hash = 'a'.repeat(40);
  const candidate = { indexerId: 7, guid: 'pack' };
  const files = Array.from({ length: 12 }, (_, i) => ({
    name: `group/episode-${String(i + 1).padStart(2, '0')}.mkv`,
    size: 1000 + i, episodeIds: [1001 + i],
    dev: '1', ino: String(i + 2), mtimeNs: '3',
  }));
  const { attemptId } = acquisition.reserve({ requestId: submitted.requestId,
    candidate, episodeIds: files.flatMap((file) => file.episodeIds),
    evidencePolicy: 'first_time_permissive', nowMs: 200 });
  acquisition.bindPreparedTorrent({ attemptId, candidate, hash, nowMs: 201 });
  acquisition.recordFilePlan({ attemptId, hash,
    plannedFiles: files.map(({ name, size, episodeIds }) => ({
      name, size, episodeIds })), nowMs: 202 });
  acquisition.beginDispatch({ attemptId, nowMs: 203 });
  acquisition.recordTorrent({ attemptId, hash, nowMs: 204 });
  acquisition.beginStart({ attemptId, hash,
    manifestDigest: 'c'.repeat(64), nowMs: 205 });
  const original=path.join(root,'original.mkv');
  await writeFile(original,Buffer.alloc(files[0].size,1));
  await utimes(original,1700000000,1700000000);
  const physical=await stat(original,{bigint:true});
  Object.assign(files[0],{dev:String(physical.dev),ino:String(physical.ino),mtimeNs:String(physical.mtimeNs)});
  moves.recordIntent({ attemptId, torrentHash: hash,
    stagingRoot: path.join(root, 'staging', hash),
    holdingPath: path.join(root, 'holding',
      `negev-${attemptId}-${hash.slice(0, 16)}`),
    files, nowMs: 206 });
  moves.markPrepared({ attemptId, nowMs: 207 });
  moves.beginPublish({ attemptId, nowMs: 208 });
  moves.markPublished({ attemptId, nowMs: publishedMs });
  rescan ??= openShokoRescanLedger(dbPath);
  return { root, dbPath, acquisition, moves, rescan, attemptId, files,
    close: async () => { rescan.close(); moves.close(); acquisition.close();
      await rm(root, { recursive: true, force: true }); } };
}


for (const prior of [null,'observed','dispatched','linked','unresolved']) {
  test('another inode cannot gain recovery ownership after restart: '+(prior??'first adoption'),async t=>{
    const x=await fixture();let ledger=x.rescan;
    try {
      const file=x.files[0],original=path.join(x.root,'original.mkv'),alternate=path.join(x.root,'Anime',path.basename(file.name));
      await mkdir(path.dirname(alternate));await writeFile(alternate,Buffer.alloc(file.size,2));await utimes(alternate,1700000000,1700000000);
      assert.notEqual((await stat(original,{bigint:true})).ino,(await stat(alternate,{bigint:true})).ino);
      assert.equal((await stat(original,{bigint:true})).mtimeNs,(await stat(alternate,{bigint:true})).mtimeNs);
      const physical=await stat(original,{bigint:true});
      if(prior){ledger.observeFile({attemptId:x.attemptId,fileName:file.name,fileId:81,nowMs:300209});
        if(prior!=='observed')ledger.beginDispatch({attemptId:x.attemptId,fileName:file.name,fileId:81,nowMs:360209});
        if(prior==='unresolved')ledger.markUnresolved({attemptId:x.attemptId,fileName:file.name,fileId:81,nowMs:660209});
        if(prior==='linked')ledger.markLinked({attemptId:x.attemptId,fileName:file.name,fileId:81,nowMs:360210});}
      ledger.close();ledger=openShokoRescanLedger(x.dbPath);
      const item=ledger.listDue({nowMs:1000000})[0];item.manifest.files=[item.manifest.files[0]];
      let calls=0;
      const result=await processShokoRescan({item,ledger,importRoot:path.join(x.root,'Import'),shokoMount:{localRoot:x.root,appRoot:'/pure'},nowMs:1000000,
        readQueue:async()=>({state:'queue_idle_unverified'}),readFile:async({sourcePath})=>sourcePath==='/'+path.basename(file.name)?[{ID:81,Size:file.size,Created:new Date(209).toISOString(),Locations:[{AbsolutePath:'/pure/Anime/'+path.basename(file.name),IsAccessible:true}],SeriesIDs:[{SeriesID:{ID:4,AniDB:42},EpisodeIDs:[{AniDB:file.episodeIds[0]}]}]}]:[],
        rescan:async()=>{calls++;return{state:'accepted'}},verifyPlex:async()=>({state:'available',fileId:81})});
      assert.notEqual(result.state,'linked');assert.notEqual(ledger.getAttemptStatus(x.attemptId),'done');assert.equal(calls,0);
      if(!prior)assert.equal(ledger.getFile(x.attemptId,file.name),null);
    }finally{ledger.close();x.moves.close();x.acquisition.close();await rm(x.root,{recursive:true,force:true});}
  });
}

for(const mode of ['moved','published','separate-source','ambiguous','missing-identity','wrong-prior-id','unconfirmed-rescan','stale-ambiguous','stale-wrong-prior-id','wrong-source-occupant']){
  test('durable physical attribution: '+mode,async()=>{
    const x=await fixture();let ledger=x.rescan;
    try{
      const file=x.files[0],importRoot=path.join(x.root,'Import');
      const child='negev-'+x.attemptId+'-'+('a'.repeat(16));
      const atSource=['published','separate-source','unconfirmed-rescan'].includes(mode);
      const destination=atSource?path.join(importRoot,child,...file.name.split('/')):path.join(x.root,'Anime',path.basename(file.name));
      await mkdir(path.dirname(destination),{recursive:true});await rename(path.join(x.root,'original.mkv'),destination);
      const sourcePath=mode==='separate-source'?'/pure/.handoff/Import/'+child+'/'+file.name:
        '/pure/'+path.relative(x.root,destination).split(path.sep).join('/');
      if(['wrong-prior-id','stale-wrong-prior-id'].includes(mode))ledger.observeFile({attemptId:x.attemptId,fileName:file.name,fileId:82,nowMs:300209});
      ledger.close();ledger=openShokoRescanLedger(x.dbPath);
      const item=ledger.listDue({nowMs:1000000})[0];item.manifest.files=[item.manifest.files[0]];
      if(mode==='missing-identity')delete item.manifest.files[0].ino;
      const shokoFile={ID:81,Size:file.size,Created:new Date(209).toISOString(),Locations:[{AbsolutePath:sourcePath,IsAccessible:true}],
        SeriesIDs:mode==='unconfirmed-rescan'?[]:[{SeriesID:{ID:4,AniDB:42},EpisodeIDs:[{AniDB:file.episodeIds[0]}]}]};
      const originalSource='/pure/Import/'+child+'/'+file.name;
      if(mode.startsWith('stale-'))shokoFile.Locations.unshift({AbsolutePath:originalSource,IsAccessible:false});
      if(mode==='wrong-source-occupant'){
        const occupant=path.join(importRoot,child,...file.name.split('/'));
        await mkdir(path.dirname(occupant),{recursive:true});await writeFile(occupant,Buffer.alloc(file.size,2));
      }
      let calls=0;
      const options={item,ledger,importRoot,shokoMount:{localRoot:x.root,appRoot:'/pure'},
        ...(mode==='separate-source'?{shokoSourcePath:'/pure/.handoff'}:{}),
        readQueue:async()=>({state:'queue_idle_unverified'}),
        readFile:async({sourcePath:query})=>{
          if(mode==='wrong-source-occupant'&&query===originalSource)return [{...shokoFile,ID:99,Locations:[{AbsolutePath:originalSource,IsAccessible:true}]}];
          return (query===sourcePath||(mode.startsWith('stale-')&&query===originalSource)||(!atSource&&query==='/'+path.basename(file.name)))?
            ['ambiguous','stale-ambiguous'].includes(mode)?[shokoFile,{...shokoFile,ID:82}]:[shokoFile]:[];
        },
        rescan:async()=>{calls++;throw Error('uncertain response')},verifyPlex:async()=>({state:'available',fileId:81})};
      const result=await processShokoRescan({...options,nowMs:1000000});
      if(mode==='unconfirmed-rescan'){
        assert.equal(result.state,'observed');assert.equal((await processShokoRescan({...options,nowMs:1060000})).state,'rescan_unconfirmed');
        ledger.close();ledger=openShokoRescanLedger(x.dbPath);shokoFile.SeriesIDs=[{SeriesID:{ID:4,AniDB:42},EpisodeIDs:[{AniDB:file.episodeIds[0]}]}];
        assert.equal((await processShokoRescan({...options,ledger,nowMs:1120000})).state,'linked');assert.equal(calls,1);
        assert.deepEqual(ledger.listEvents({attemptId:x.attemptId}).map(e=>e.event),['observed','dispatch','unconfirmed','linked']);
      }else{
        assert.equal(result.state,['moved','published','separate-source'].includes(mode)?'linked':mode==='missing-identity'?'held':['wrong-prior-id','stale-wrong-prior-id','wrong-source-occupant'].includes(mode)?'awaiting_shoko':'rescan_unresolved');
        assert.equal(calls,0);
      }
      assert.equal((await stat(destination)).size,file.size,'all checks preserve usable files');
    }finally{ledger.close();x.moves.close();x.acquisition.close();await rm(x.root,{recursive:true,force:true});}
  });
}
for(const sourceLookup of ['empty','stale-location']) for (const prior of [null,'observed','dispatched','linked','unresolved']) {
  test('old Shoko record identifies exact physical file after '+sourceLookup+' source lookup: '+(prior??'first adoption'),async t=>{
    const x=await fixture({publishedMs:100000});let ledger=x.rescan;
    try {
      const file=x.files[0],original=path.join(x.root,'original.mkv'),alternate=path.join(x.root,'Anime',path.basename(file.name));
      await mkdir(path.dirname(alternate));await rename(original,alternate);
      if(prior){ledger.observeFile({attemptId:x.attemptId,fileName:file.name,fileId:81,nowMs:300209});
        if(prior!=='observed')ledger.beginDispatch({attemptId:x.attemptId,fileName:file.name,fileId:81,nowMs:360209});
        if(prior==='unresolved')ledger.markUnresolved({attemptId:x.attemptId,fileName:file.name,fileId:81,nowMs:660209});
        if(prior==='linked')ledger.markLinked({attemptId:x.attemptId,fileName:file.name,fileId:81,nowMs:360210});}
      ledger.close();ledger=openShokoRescanLedger(x.dbPath);
      const item=ledger.listDue({nowMs:1000000})[0];item.manifest.files=[item.manifest.files[0]];
      let calls=0;
      const result=await processShokoRescan({item,ledger,importRoot:path.join(x.root,'Import'),shokoMount:{localRoot:x.root,appRoot:'/pure'},nowMs:1000000,
        readQueue:async()=>({state:'queue_idle_unverified'}),readFile:async({sourcePath})=>(sourceLookup==='stale-location'||sourcePath==='/'+path.basename(file.name))?[{ID:81,Size:file.size,Created:new Date(0).toISOString(),Locations:[{AbsolutePath:'/pure/Import/negev-'+x.attemptId+'-'+('a'.repeat(16))+'/'+file.name,IsAccessible:false},{AbsolutePath:'/pure/Anime/'+path.basename(file.name),IsAccessible:true}],SeriesIDs:[{SeriesID:{ID:4,AniDB:42},EpisodeIDs:[{AniDB:file.episodeIds[0]}]}]}]:[],
        rescan:async()=>{calls++;return{state:'accepted'}},verifyPlex:async()=>({state:'available',fileId:81})});
      assert.equal(result.state,'linked');assert.equal(ledger.getAttemptStatus(x.attemptId),'done');assert.equal(calls,0);
      assert.equal(ledger.getFile(x.attemptId,file.name).fileId,81);assert.equal((await stat(alternate)).size,file.size);
    }finally{ledger.close();x.moves.close();x.acquisition.close();await rm(x.root,{recursive:true,force:true});}
  });
}
