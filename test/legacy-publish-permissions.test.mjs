import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,writeFile,chmod,rename} from 'node:fs/promises';
import {stoppedPack} from './helpers/stopped-pack.mjs';
import {ed2kBuffer} from '../src/identity/ed2k.mjs';
import {prepareHandoffBatch} from '../src/acquisition/prepare-handoff-batch.mjs';
import {publishPreparedHandoff} from '../src/acquisition/publish-handoff-batch.mjs';
import {restorePreparedHandoff} from '../src/acquisition/restore-prepared-handoff.mjs';
import {openHandoffLedger} from '../src/acquisition/handoff-ledger.mjs';

for(const failure of ['chmod','chmod_applied','restore_failed','rename'])test(`legacy publisher distinguishes certain pre-rename failure from unknown rename: ${failure}`,async t=>{
 const x=await stoppedPack(t,{count:1,selected:[1],priorityFailure:'none'});
 await x.submit();await x.start();
 const stagingRoot=path.join(x.root,'staging'),holdingRoot=path.join(x.root,'holding'),importRoot=path.join(x.root,'import');
 await Promise.all([stagingRoot,holdingRoot,importRoot].map(dir=>mkdir(dir)));
 const file=x.selectedFiles[0],bytes=Buffer.alloc(file.size,1),ed2k=ed2kBuffer(bytes);
 await writeFile(path.join(stagingRoot,file.name),bytes);
 const prepared=await prepareHandoffBatch({stagingRoot,holdingRoot,importRoot,
  verified:{state:'batch_identity_verified',handoffReady:false,torrentHash:x.hash,anidbId:42,
   files:[{...file,ed2k,anidbFileId:51}],subtitles:[]},readPacer:{afterBytes:async()=>{}}});
 assert.equal(prepared.state,'handoff_prepared',JSON.stringify(prepared));
 let ledger=openHandoffLedger(x.dbPath),renames=0,fail=true,lookups=0;
 try{
  assert.equal(ledger.recordPrepared({attemptId:x.attemptId,prepared,nowMs:400}).state,'prepared');
  const input={attemptId:x.attemptId,holdingRoot,importRoot,readPacer:{afterBytes:async()=>{}},
   lookup:async({ed2k,size})=>{lookups++;return{status:200,release:{id:`anidb://${ed2k}+${size}`,providerName:'AniDB',releaseURI:'https://anidb.net/file/51',fileSize:size,isCorrupted:false,hashes:[{type:'ED2K',value:ed2k}],crossReferences:[{anidbAnimeID:42,anidbEpisodeID:1001,percentageStart:null,percentageEnd:null}]}};},
   chmodImpl:async(file,mode)=>{if(failure!=='rename'&&fail&&mode===0o755){fail=false;if(failure==='chmod_applied')await chmod(file,mode);throw Error('temporary chmod failure');}if(failure==='restore_failed'&&mode===0o700)throw Error('privacy restore failed');await chmod(file,mode);},
   renamePrepared:async(source,destination)=>{renames++;if(failure==='rename')throw Error('rename outcome unknown');await rename(source,destination);}};
  const first=await publishPreparedHandoff({...input,ledger,prepared,nowMs:500});assert.equal(first.state,'held');
  if(failure.startsWith('chmod')){assert.equal(first.reason,'publish_permissions_unavailable');assert.equal(renames,0);assert.equal(ledger.getHandoff(x.attemptId).status,'prepared');}
  else assert.equal(ledger.getHandoff(x.attemptId).status,'publish_unknown');
  assert.equal(ledger.cancelUnsentPublish({attemptId:x.attemptId,evidenceDigest:prepared.evidenceDigest,sendToken:'11111111-1111-4111-8111-111111111111',nowMs:500}).state,'held','a different operation token cannot reset publication');
  ledger.close();ledger=openHandoffLedger(x.dbPath);
  const restored=restorePreparedHandoff({attemptId:x.attemptId,handoff:ledger.getHandoff(x.attemptId)});
  const second=await publishPreparedHandoff({...input,ledger,prepared:restored,nowMs:600});
  assert.equal(second.state,failure.startsWith('chmod')?'published_observed':'held',JSON.stringify(second));
  assert.equal(renames,failure==='restore_failed'?0:1,'uncertain rename is never sent twice');
  if(failure.startsWith('chmod'))assert.ok(lookups>=2,'replay checks bytes and identity again');
 }finally{ledger.close();}
});
