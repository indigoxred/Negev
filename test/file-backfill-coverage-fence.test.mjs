import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {openFileBackfillCursor} from '../src/availability/file-backfill-cursor.mjs';
import {createFileBackfillWorker} from '../src/availability/file-backfill-worker.mjs';
for(const changed of [true,false])test(changed?'fresh percentage change with unchanged timestamp rejects the old proposal':'percentage ordering is canonical across the two exact reads',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'backfill-coverage-fence-'));const cursor=openFileBackfillCursor(path.join(dir,'state.sqlite'));let reads=0,writes=0;
 const base={state:'candidate',fileId:7,updated:'2026-11-02T00:00:00Z',size:5,anidbFileId:900,releaseEvidence:'registered',pairs:[{anidbId:42,episodeId:1001},{anidbId:42,episodeId:1002}],identities:[{anidbId:42,episodeId:1001,shokoSeriesId:99,shokoEpisodeId:2001,tmdbMovieIds:[]},{anidbId:42,episodeId:1002,shokoSeriesId:99,shokoEpisodeId:2002,tmdbMovieIds:[]}],sourcePaths:['/pure/Anime/a.mkv']};
 const worker=createFileBackfillWorker({cursor,inventory:{getFile:()=>({state:'linked',updated:base.updated,observedMs:100}),listFileHintIds:({afterFileId})=>afterFileId<7?[7]:[]},readCandidate:async()=>{const later=++reads>1;const coverage=[{episodeId:1001,start:0,end:later&&changed?50:100},{episodeId:1002,start:0,end:100}];return {...base,coverage:later?coverage.reverse():coverage};},resolveKind:async()=> 'series',observeCandidate:async()=>({state:'available',fileId:7,proof:{fileId:7},cardRevision:{observedMs:200}}),proofs:{observeGuarded:()=>{writes++;return {state:'recorded'};}},now:()=>300});
 try{const result=await worker.runOnce();assert.equal(result.available,changed?0:2);assert.equal(writes,changed?0:2);}finally{cursor.close();await rm(dir,{recursive:true,force:true});}
});
