import {createUserService as createRawUserService} from '../../src/web/user-service.mjs';
import {openAvailabilityScope} from '../../src/availability/availability-scope.mjs';
const machine='synthetic-machine';
export async function createUserService(config){
 const original=config.fetchImpl??fetch;
 const service=await createRawUserService({...config,fetchImpl:async(url,init)=>{
  if(config.plex && new URL(url).origin===new URL(config.plex.plexBaseUrl).origin && new URL(url).pathname==='/identity') {
   if(init.redirect!=='manual'||init.headers['X-Plex-Token']!==config.plex.plexToken)throw Error('Invalid identity authentication');
   return Response.json({MediaContainer:{machineIdentifier:machine}});
  }
  return original(url,init);
 }});
 if(config.plex)await service.ensurePublicAvailabilityScope();
 return service;
}
// Saved-proof fixtures model a prior successfully validated installation.
// Bind its exact scope before seeding proof rows, never after seeding them.
export function primeSavedScope({dbPath,localRoot,shokoBaseUrl='http://shoko.internal:8111',plexBaseUrl='http://plex.internal:32400',observedMs=1}){
 const endpoint=value=>{const u=new URL(value);return u.origin+u.pathname;};
 const scope=openAvailabilityScope(dbPath);
 try{scope.reconcile({serverIdentity:JSON.stringify([machine,endpoint(plexBaseUrl),endpoint(shokoBaseUrl)]),episodeLibraryIds:[102],movieLibraryIds:[],shokoMount:{appRoot:'/pure',localRoot},plexMounts:[{appRoot:'/source-pure',localRoot}],observedMs});}finally{scope.close();}
}
