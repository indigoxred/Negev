import {DatabaseSync,backup} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {mkdtemp,rm,chmod,realpath,lstat} from 'node:fs/promises';
import path from 'node:path';
import {availabilityScopeSignature,openAvailabilityScope} from './availability-scope.mjs';
import {openPlexCardIndex} from './plex-card-index.mjs';
import {openFileProofLedger} from './file-proof-ledger.mjs';
import {probePhysicalCandidate} from './physical-plex-part.mjs';
import {localPath} from './known-card-availability.mjs';
// An explicit cache-only upgrade operation. Prepare against a consistent copy,
// then publish atomically only if the original source/cache generations match.
// Request, account, acquisition and Shoko inventory tables are never replaced.
const cacheTables=['availability_scope','plex_card_observations','plex_part_candidates',
 'plex_card_change_events','plex_card_cursors','plex_sweep_passes','plex_sweep_keys',
 'plex_card_retries','plex_card_removals','file_availability_proofs',
 'title_check_positive_proofs','direct_availability_targets','title_check_jobs','title_check_targets'];
const sourceTables=['shoko_inventory_files','shoko_inventory_pairs','shoko_inventory_file_hints'];
const exists=(db,name)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const fingerprint=db=>{
 const hash=createHash('sha256');
 for(const name of [...sourceTables,...cacheTables]){
  hash.update(name);const schema=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name);hash.update(schema?.sql??'absent');
  if(schema)for(const row of db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).iterate())hash.update(JSON.stringify(row));
 }
 return hash.digest('hex');
};
const time=n=>Number.isSafeInteger(n)&&n>=0;
export async function importQualifiedAvailability({dbPath,manifest,scope,positiveLifetimeMs,now=Date.now,probeImpl=probePhysicalCandidate,scratchDir}={}){
 const clock=now(),signature=availabilityScopeSignature(scope);
 if(typeof dbPath!=='string'||!path.isAbsolute(dbPath)||typeof probeImpl!=='function'||
  !time(clock)||!Number.isSafeInteger(positiveLifetimeMs)||positiveLifetimeMs<1||positiveLifetimeMs>604800000||
  manifest?.formatVersion!==1||typeof manifest.migrationId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(manifest.migrationId)||
  manifest.scopeSignature!==signature||!time(manifest.qualifiedAtMs)||manifest.qualifiedAtMs>clock||
  !Array.isArray(manifest.cards)||manifest.cards.length>20000||!Array.isArray(manifest.receipts)||manifest.receipts.length>50000)throw new TypeError('Invalid qualified cache manifest or current scope');
 const privateRoot=await realpath(path.dirname(dbPath)),scratch=await realpath(scratchDir??path.dirname(dbPath));
 const relative=path.relative(privateRoot,scratch),scratchInfo=await lstat(scratchDir??path.dirname(dbPath));
 if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)||!scratchInfo.isDirectory()||scratchInfo.isSymbolicLink()||process.platform!=='win32'&&(scratchInfo.mode&0o077)!==0)throw new Error('Private migration scratch directory required');
 const dir=await mkdtemp(path.join(scratch,'.cache-upgrade-'));await chmod(dir,0o700);
 let live,staged,index,proofs,scopeLedger;
 try{
  live=new DatabaseSync(dbPath,{timeout:5000});const original=fingerprint(live),stagedPath=path.join(dir,'prepared.sqlite');await backup(live,stagedPath);await chmod(stagedPath,0o600);
  scopeLedger=openAvailabilityScope(stagedPath);scopeLedger.reconcile(scope);scopeLedger.close();scopeLedger=null;
  index=openPlexCardIndex(stagedPath);proofs=openFileProofLedger(stagedPath,{positiveLifetimeMs,now});
  const cards=new Map(),latestCardTime=new Map();
  for(const card of manifest.cards){
   const allowed=card?.kind==='episode'?scope.episodeLibraryIds:card?.kind==='movie'?scope.movieLibraryIds:[];
   if(!allowed.includes(card.libraryId)||!time(card.observedMs)||card.observedMs>manifest.qualifiedAtMs)throw new TypeError('Invalid qualified card scope or time');
   index.recordCard(card);const identity=card.libraryId+':'+card.ratingKey;latestCardTime.set(identity,Math.max(latestCardTime.get(identity)??-1,card.observedMs));const key=card.libraryId+':'+card.ratingKey+':'+card.observedMs;
   if(cards.has(key)&&JSON.stringify(cards.get(key))!==JSON.stringify(card))throw new TypeError('Conflicting qualified card');cards.set(key,card);
  }
  const checked=new Map(),accepted=[];let recorded=0,skipped=0;
  for(const receipt of manifest.receipts){
   if(!time(receipt?.checkedMs)||receipt.checkedMs>manifest.qualifiedAtMs)throw new TypeError('Invalid qualified proof time');
   if(receipt.checkedMs+positiveLifetimeMs<=clock){skipped++;continue;}
   const card=cards.get(receipt.proof?.libraryId+':'+receipt.proof?.ratingKey+':'+receipt.revision?.card?.observedMs);
   const parts=receipt.proof?.parts??[receipt.proof];let usable=!!card;
   if(!Array.isArray(parts)||parts.length<1||parts.length>40)throw new TypeError('Invalid qualified proof parts');
   for(const part of parts){
    const candidate=card?.parts.find(p=>p.partId===part?.partId&&p.candidateKey===part.storageKey);
    const mount=candidate&&scope.plexMounts.find(m=>localPath(candidate.plexPath,m));
    if(!candidate||!mount||(!Array.isArray(receipt.proof.parts)&&(candidate.partCount>1||candidate.mediaId!=null&&(card.parts.filter(p=>p.mediaId===candidate.mediaId).length>1||card.parts.some(p=>p.mediaId===candidate.mediaId&&(p.partCount>1||p.partIndex>0)))))){usable=false;break;}
    const key=candidate.plexPath+':'+candidate.candidateKey;
    if(!checked.has(key))checked.set(key,await probeImpl({filePath:localPath(candidate.plexPath,mount),allowedRoot:mount.localRoot,backingRoots:[scope.shokoMount.localRoot],expectedSize:candidate.size}));
    const physical=checked.get(key);if(physical?.state!=='candidate'||physical.candidateKey!==part.storageKey){usable=false;break;}
   }
   if(!usable){skipped++;continue;}
   const result=proofs.observeGuarded(receipt);if(['recorded','stale'].includes(result.state))accepted.push(receipt);else skipped++;
  }
  // Replay later accepted card observations through the normal invalidator.
  // Identical identity keeps the original proof timestamp; a later change or
  // removal invalidates it. Never roll current card generations backwards.
  const currentCards=exists(live,'plex_card_observations')?live.prepare('SELECT * FROM plex_card_observations').all():[];
  for(const row of currentCards){
   const qualifiedTime=latestCardTime.get(row.library_id+':'+row.rating_key);
   if(qualifiedTime===row.observed_ms&&index.getCardRevision({libraryId:row.library_id,ratingKey:row.rating_key})?.identitySignature!==row.identity_signature)throw new Error('Conflicting equal-time card snapshots');
   if(qualifiedTime===undefined||qualifiedTime>=row.observed_ms)continue;
   let parts;
   try{const [kind,raw]=JSON.parse(row.identity_signature);if(kind!==row.kind||!Array.isArray(raw))throw Error('Invalid prior card');
    parts=raw.map(([partId,size,plexPath,itemGuid,showGuid,externalGuids,candidateKey,mediaId,partIndex,partCount])=>({libraryId:row.library_id,partId,size,plexPath,itemGuid,showGuid,externalGuids,...(candidateKey?{candidateKey}:{}),...(mediaId!=null?{mediaId,partIndex,partCount}:{})}));
    index.recordCard({libraryId:row.library_id,ratingKey:row.rating_key,kind,parts,observedMs:row.observed_ms});
   }catch{index.forgetCard({libraryId:row.library_id,ratingKey:row.rating_key,observedMs:row.observed_ms});}
  }
  if(exists(live,'plex_card_removals'))for(const row of live.prepare('SELECT * FROM plex_card_removals').iterate())
   index.forgetCard({libraryId:row.library_id,ratingKey:row.rating_key,observedMs:row.observed_ms});
  proofs.close();proofs=null;index.close();index=null;staged=new DatabaseSync(stagedPath,{readOnly:true});
  const retained=staged.prepare('SELECT 1 FROM file_availability_proofs WHERE anidb_id=? AND episode_id=? AND file_id=? AND library_id=? AND rating_key=? AND part_id=? AND verified_ms>=?');
  for(const r of accepted){const p=r.proof;if(retained.get(r.anidbId,r.episodeId,p.fileId,p.libraryId,p.ratingKey,p.partId,r.checkedMs))recorded++;else skipped++;}

  live.prepare('ATTACH DATABASE ? AS qualified_cache').run(stagedPath);live.exec('BEGIN IMMEDIATE');
  try{
   if(fingerprint(live)!==original)throw new Error('Source or cache changed during qualified migration');
   for(const name of cacheTables){
    if(!exists(staged,name))continue;
    const schema=staged.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name).sql;
    if(!exists(live,name))live.exec(schema);
    const columns=db=>db.prepare(`PRAGMA table_info("${name}")`).all().map(c=>c.name);
    if(JSON.stringify(columns(live))!==JSON.stringify(columns(staged))){
     // Publish the supported additive proof-payload migration in the same
     // transaction as the qualified cache. Do not rebuild unknown schemas.
     const prior=live.prepare(`PRAGMA table_info("${name}")`).all(),next=staged.prepare(`PRAGMA table_info("${name}")`).all();
     if(name!=='file_availability_proofs'||next.length!==prior.length+1||
       next.at(-1).name!=='components_json'||next.at(-1).type!=='TEXT'||next.at(-1).notnull||next.at(-1).dflt_value!==null||
       JSON.stringify(prior)!==JSON.stringify(next.slice(0,-1)))throw new Error('Unsupported cache schema transition');
     live.exec('ALTER TABLE file_availability_proofs ADD COLUMN components_json TEXT');
    }
   }
   // Delete children before their parents; unrelated table rows are untouched.
   for(const name of [...cacheTables].reverse())if(exists(staged,name))live.exec(`DELETE FROM "${name}"`);
   for(const name of cacheTables)if(exists(staged,name))live.exec(`INSERT INTO "${name}" SELECT * FROM qualified_cache."${name}"`);
   live.exec('COMMIT');
  }catch(error){live.exec('ROLLBACK');throw error;}
  return{state:'imported',recorded,skipped,physicalFilesChecked:checked.size,originalTimestamps:true};
 }finally{proofs?.close();index?.close();scopeLedger?.close();staged?.close();live?.close();await rm(dir,{recursive:true,force:true});}
}
