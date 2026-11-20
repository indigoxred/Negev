import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { processRecognitionRecovery } from
  '../src/acquisition/process-recognition-recovery.mjs';

const manifest = { attemptId: 7, torrentHash: 'a'.repeat(40),
  holdingPath: '/pure/holding/negev-7-aaaaaaaaaaaaaaaa',
  files: [{ name: '01.mkv', size: 1000, episodeIds: [1001] }] };
const file = { ID: 81, Size: 1000, SeriesIDs: [],
  Locations: [{ AbsolutePath: '/pure/Import/Negev/negev-7-aaaaaaaaaaaaaaaa/01.mkv',
    IsAccessible: true }] };
const localRoot = path.join(process.cwd(), 'pure');
const mount = { appRoot: '/pure', localRoot };

test('never moves before two quiet Shoko observations and a stopped torrent', async () => {
  let saved = null;
  let moves = 0;
  const recovery = {
    getEligible: () => ({ requestId: 4, manifest, video: manifest.files[0],
      publishedMs: 0 }),
    get: () => saved,
    recordFirstSeen: ({ fileId, nowMs }) => {
      saved = { status: 'observed', fileId, firstSeenMs: nowMs };
      return { state: 'observed' };
    },
    beginPreserve: () => ({ state: 'preserve_unknown' }),
    markPreserved: () => ({ state: 'preserved' }),
    releaseForAlternate: () => ({ state: 'released' }),
  };
  const base = { attemptId: 7, recovery,
    pureMoves: { getIntent: () => ({ status: 'published_observed', manifest }) },
    importRoot: path.join(localRoot, 'Import', 'Negev'),
    holdingRoot: path.join(localRoot, 'holding'), shokoMount: mount,
    readQueue: async () => ({ state: 'quiet_observed' }),
    readFile: async () => [file],
    readUnrecognized: async () => ({ state: 'unrecognized' }),
    checkTorrent: async () => ({ state: 'stopped' }),
    preserve: async () => { moves++; return { state: 'preserved' }; },
  };
  assert.equal((await processRecognitionRecovery({ ...base,
    nowMs: 600_000 })).state, 'awaiting_shoko');
  assert.equal(moves, 0);
  assert.equal((await processRecognitionRecovery({ ...base,
    nowMs: 660_000, checkTorrent: async () => ({ state: 'active' }) }))
    .state, 'held');
  assert.equal(moves, 0);
  assert.equal((await processRecognitionRecovery({ ...base,
    nowMs: 660_000 })).state, 'recovered');
  assert.equal(moves, 1);
});


test('the separate Shoko Source mount resolves the same exact preserved file',async()=>{
 let observed=false;
 const result=await processRecognitionRecovery({attemptId:7,
 recovery:{getEligible:()=>({requestId:4,manifest,video:manifest.files[0],publishedMs:0}),get:()=>null,recordFirstSeen:()=>{observed=true;},beginPreserve:()=>{},markPreserved:()=>{},releaseForAlternate:()=>{}},
 pureMoves:{getIntent:()=>({status:'published_observed',manifest})},importRoot:path.join(process.cwd(),'handoff','source','Negev'),holdingRoot:path.join(process.cwd(),'handoff','holding'),shokoMount:mount,shokoSourcePath:'/pure/.negev-handoff/source',nowMs:600000,
 readQueue:async()=>({state:'quiet_observed'}),readFile:async({sourcePath})=>{assert.equal(sourcePath,'/pure/.negev-handoff/source/Negev/negev-7-aaaaaaaaaaaaaaaa/01.mkv');return[{...file,Locations:[{AbsolutePath:sourcePath,IsAccessible:true}]}]},readUnrecognized:async()=>({state:'unrecognized'}),checkTorrent:async()=>({state:'stopped'}),preserve:async()=>{throw Error('needs two observations')}});
 assert.equal(result.state,'awaiting_shoko');assert.equal(observed,true);
});
