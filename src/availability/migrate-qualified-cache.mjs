import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {open,realpath,stat,mkdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {parseUserServerConfig} from '../web/user-server-config.mjs';
import {readPrivatePlexToken,readPrivateShokoKey} from '../web/private-shoko-key.mjs';
import {readBoundedJson,cancelResponseBody} from '../http/bounded-response.mjs';
import {importQualifiedAvailability} from './import-qualified-cache.mjs';
import {availabilityScopeSignature} from './availability-scope.mjs';
import {DatabaseSync} from 'node:sqlite';
import {createPlexAvailabilityService} from './plex-availability-service.mjs';
import {openShokoInventoryLedger} from './shoko-inventory-worker.mjs';
import {openFileProofLedger} from './file-proof-ledger.mjs';
import {readShokoFileCandidate} from './shoko-file-candidate.mjs';
import {warmRequestedAvailability} from './warm-request-cache.mjs';
// Explicit one-time maintenance entry point, not a server or background task.
// Stop Negev and take a SQLite/WAL-consistent private backup before invoking.
export async function readQualifiedManifest({dataDir,filePath}={}){
 if(typeof dataDir!=='string'||typeof filePath!=='string'||!path.isAbsolute(filePath))throw new TypeError('Private absolute manifest required');
 const root=await realpath(dataDir),resolved=await realpath(filePath),relative=path.relative(root,resolved);
 const samePath=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
 if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)||!samePath(resolved,path.resolve(filePath)))throw new Error('Manifest must be a canonical private data file');
 const handle=await open(filePath,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
 try{
  const before=await handle.stat();
  if(!before.isFile()||before.size<2||before.size>64*1024*1024||process.platform!=='win32'&&((before.mode&0o077)!==0||before.uid!==process.getuid()))throw new Error('Unsafe private manifest');
  const bytes=await handle.readFile(),after=await handle.stat(),current=await stat(filePath);
  if(bytes.length!==before.size||before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||current.dev!==before.dev||current.ino!==before.ino)throw new Error('Manifest changed while reading');
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
 }finally{await handle.close();}
}
export async function migrateQualifiedCache({config,manifestPath,fetchImpl=fetch,now=Date.now,warmRequestsOnly=false}={}){
 if(!config?.plex||!config.fileProofLifetimeMs)throw new Error('Configured public availability is required');
 const manifest=await readQualifiedManifest({dataDir:config.dataDir,filePath:manifestPath});
 const plex=config.plex,token=await readPrivatePlexToken({dataDir:config.dataDir,keyPath:plex.plexTokenPath});
 const response=await fetchImpl(new URL('/identity',plex.plexBaseUrl),{method:'GET',redirect:'manual',headers:{'X-Plex-Token':token,Accept:'application/json'},signal:AbortSignal.timeout(10000)});
 if(response.status!==200){await cancelResponseBody(response);throw new Error('Current public server identity unavailable');}
 const machine=(await readBoundedJson(response,100000))?.MediaContainer?.machineIdentifier;
 if(typeof machine!=='string'||!/^[A-Za-z0-9_-]{1,256}$/.test(machine))throw new Error('Invalid current public server identity');
 const endpoint=value=>{const u=new URL(value);return u.origin+u.pathname;};
 const scope={serverIdentity:JSON.stringify([machine,endpoint(plex.plexBaseUrl),endpoint(config.shokoBaseUrl)]),episodeLibraryIds:plex.publicSections.episode,movieLibraryIds:plex.publicSections.movie,shokoMount:plex.shokoMount,plexMounts:plex.plexMounts??[plex.plexMount],observedMs:now()};
 const scratchDir=path.join(config.dataDir,'.cache-upgrade');await mkdir(scratchDir,{recursive:true,mode:0o700});
 const dbPath=path.join(config.dataDir,'negev.sqlite');
 if(manifest.scopeSignature!==availabilityScopeSignature(scope))throw new Error('Current scope differs from qualification');
 let imported;
 if(warmRequestsOnly){const db=new DatabaseSync(dbPath,{readOnly:true});try{if(db.prepare('SELECT signature FROM availability_scope WHERE id=1').get()?.signature!==manifest.scopeSignature)throw new Error('Initialized public scope required');}finally{db.close();}imported={state:'unchanged'};}
 else imported=await importQualifiedAvailability({scratchDir,dbPath,manifest,scope,positiveLifetimeMs:config.fileProofLifetimeMs,now});
 const shokoApiKey=await readPrivateShokoKey({dataDir:config.dataDir,keyPath:config.shokoApiKeyPath});
 const observer=createPlexAvailabilityService({...plex,dbPath,shokoBaseUrl:config.shokoBaseUrl,shokoApiKey,plexToken:token,fetchImpl,now,enforceScope:true});
 const inventory=openShokoInventoryLedger(dbPath),proofs=openFileProofLedger(dbPath,{positiveLifetimeMs:config.fileProofLifetimeMs,now,evidenceTrusted:()=>observer.isScopeCurrent()});
 try{if((await observer.ensureScope()).state!=='ready')throw new Error('Public scope unavailable');
  const requested=await warmRequestedAvailability({dbPath,observer,inventory,proofs,now,readCandidate:input=>readShokoFileCandidate({...input,baseUrl:config.shokoBaseUrl,apiKey:shokoApiKey,fetchImpl})});
  return{...imported,requested};
 }finally{proofs.close();inventory.close();observer.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 try{
  if(![5,6].includes(process.argv.length)||process.argv[2]!=='--manifest'||process.argv[4]!=='--stopped-service-confirmed'||process.argv.length===6&&process.argv[5]!=='--warm-requests-only')throw new Error('Usage: --manifest PRIVATE_FILE --stopped-service-confirmed (stop Negev and back up its SQLite/WAL first)');
  console.log(JSON.stringify(await migrateQualifiedCache({config:parseUserServerConfig(process.env),manifestPath:process.argv[3],warmRequestsOnly:process.argv[5]==='--warm-requests-only'})));
 }catch{console.error('Qualified cache migration failed; existing data was not replaced unless the atomic cache publication completed. Inspect privately and restore the saved backup if required.');process.exitCode=1;}
}
