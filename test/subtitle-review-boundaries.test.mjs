import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import test from 'node:test';
import {stoppedPack} from './helpers/stopped-pack.mjs';
import {previewRequestCandidate} from '../src/acquisition/request-candidate-preflight.mjs';

for(const recovery of [false,true])test('subtitle priority writes recheck access after awaited mount verification (recovery='+recovery+')',async t=>{
 const x=await stoppedPack(t,{priorityFailure:'none',additionalFiles:[{name:'Subs/Example - 01.en.ass',size:10}]});
 const excluded=['Example - 01.mkv','Subs/Example - 01.en.ass'];
 if(recovery){await x.submit({excludedFileNames:excluded,fetchImpl:async(input,init)=>new URL(input).pathname.endsWith('/filePrio')?new Response(null,{status:503}):x.fetchImpl(input,init)});x.files[0].priority=0;}
 let effects=0;const fetchImpl=async(input,init)=>{if(new URL(input).pathname.endsWith('/filePrio'))effects++;return x.fetchImpl(input,init)};
 let checks=0;const verifyStagingRoot=async()=>{if(recovery||++checks>1)x.state.ownerAllowed=false;return{state:'verified_staging_root'}};
 const result=recovery?await x.start({fetchImpl,verifyStagingRoot}):await x.submit({excludedFileNames:excluded,fetchImpl,verifyStagingRoot});
 assert.equal(effects,0);assert.equal(result.reason,'account_access_changed');
});

test('old pre-add selection journal can adopt verified subtitle-only exclusions across reopen',async t=>{
 const x=await stoppedPack(t,{priorityFailure:'none',additionalFiles:[{name:'Subs/Example - 01.en.ass',size:10}]});
 const first=await x.submit({fetchImpl:async()=>new Response(null,{status:503})});assert.equal(first.reason,'provider_unavailable');x.reopen();
 const result=await x.submit({excludedFileNames:['Example - 01.mkv','Subs/Example - 01.en.ass']});
 assert.equal(result.state,'stopped_observed',JSON.stringify(result));assert.equal(x.state.adds,1);assert.deepEqual(x.ledger.getTorrentSelection(x.attemptId).excludedFileNames,['Example - 01.mkv','Subs/Example - 01.en.ass']);
});

for(const owned of [false,true])test('preview protects retained bonus subtitles and excludes owned bonus subtitles (owned='+owned+')',async()=>{
 const episodes=[{id:1001,number:1,type:'Episode',title:'Regular'},{id:1002,number:2,type:'Episode',title:'Regular 2'},{id:1003,number:1,type:'Special',title:'Bonus'}],detail={state:'details',complete:true,total:3,page:1,nextPage:null,anidbId:42,title:'Example',kind:'series',restricted:false,episodes};
 const stem=owned?'Example.Special01':'Example - 01.Special01';const names=['Example - 01.mkv','Example - 02.mkv',stem+'.mkv','Subs/'+stem+'.en.ass'];
 const result=await previewRequestCandidate({requestId:4,candidate:{indexerId:7,guid:'pack',title:'[Group] Example Complete 1080p',size:400},readRequest:()=>({id:4,status:'held',anidbId:42,kind:'series',episodeIds:[1002]}),loadDetail:async()=>detail,prepare:async()=>({state:'prepared_stopped',expected:{hash:'a'.repeat(40)},files:names.map(name=>({name,size:100})),totalBytes:400,version:'v1'}),readVideoExtensions:async()=>({state:'extensions',values:['.mkv']}),readBonusOwnership:async()=>({state:owned?'owned':'missing'}),offlineLookup:async({filename})=>{const id=filename.includes('Special')?1003:filename.includes('02')?1002:1001;return {status:200,release:{ProviderName:'Offline Importer',ID:'offline://42-'+id,IsCorrupted:false,OriginalFilename:filename,CrossReferences:[{AnidbAnimeID:42,AnidbEpisodeID:id,PercentageStart:0,PercentageEnd:100}]}};}});
 assert.equal(result.state,'preflight',JSON.stringify(result));assert.equal(result.subtitles.some(f=>f.name===names[3]),!owned,JSON.stringify(result));assert.equal(result.filesToExclude.some(f=>f.name===names[3]),owned);
});

for(const changed of ['manifest','video','unrelatedSubtitle','started','sent'])test('subtitle journal upgrade retains conflict/single-send guards: '+changed,async t=>{
 const x=await stoppedPack(t,{priorityFailure:'none',additionalFiles:[{name:'Subs/Example - 01.en.ass',size:10},{name:'Subs/unrelated.en.ass',size:10}]});
 assert.equal((await x.submit({fetchImpl:async()=>new Response(null,{status:503})})).reason,'provider_unavailable');
 const old=x.ledger.getTorrentSelection(x.attemptId),files=old.files.map(f=>({...f}));let excluded=['Example - 01.mkv','Subs/Example - 01.en.ass'];
 if(changed==='manifest')files[0].size++;if(changed==='video')excluded=['Example - 02.mkv'];if(changed==='unrelatedSubtitle')excluded.push('Subs/unrelated.en.ass');
 if(changed==='started'||changed==='sent'){x.ledger.beginDispatch({attemptId:x.attemptId,nowMs:301});if(changed==='started'){x.ledger.recordTorrent({attemptId:x.attemptId,hash:x.hash,nowMs:302});x.ledger.beginStart({attemptId:x.attemptId,hash:x.hash,manifestDigest:'b'.repeat(64),nowMs:303});}}
 const result=x.ledger.recordTorrentSelection({attemptId:x.attemptId,hash:x.hash,files,excludedFileNames:excluded,nowMs:304});
 if(changed==='sent'){assert.equal(result.state,'selection_recorded');assert.deepEqual(result.excludedFileNames,old.excludedFileNames);}else assert.equal(result.reason,'torrent_selection_conflict');
 assert.deepEqual(x.ledger.getTorrentSelection(x.attemptId),old);assert.equal(x.state.adds,0);
});

test('subtitle-only pre-add upgrade is journaled once and remains stable across reopen',async t=>{
 const x=await stoppedPack(t,{additionalFiles:[{name:'Subs/Example - 01.en.ass',size:10}]});await x.submit({fetchImpl:async()=>new Response(null,{status:503})});
 const before=x.ledger.getTorrentSelection(x.attemptId),input={attemptId:x.attemptId,hash:x.hash,files:before.files,excludedFileNames:['Example - 01.mkv','Subs/Example - 01.en.ass'],nowMs:301};
 assert.equal(x.ledger.recordTorrentSelection(input).state,'selection_recorded');x.reopen();assert.equal(x.ledger.recordTorrentSelection(input).state,'selection_recorded');
 const db=new DatabaseSync(x.dbPath);try{const rows=db.prepare('SELECT * FROM acquisition_subtitle_selection_revisions WHERE attempt_id=?').all(x.attemptId);assert.equal(rows.length,1);assert.deepEqual(JSON.parse(rows[0].previous_excluded_json),before.excludedFileNames);assert.deepEqual(JSON.parse(rows[0].remaining_excluded_json),input.excludedFileNames);}finally{db.close();}
});
